import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(root, 'output/acceptance/ui');
const screenshots = !process.argv.includes('--no-screenshots');
const scenarioFilter = process.argv.find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length);
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice('--port='.length) ?? 5187);
const setupOnly = process.argv.includes('--setup-only');
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
await mkdir(base, { recursive: true });
const previous = (await readdir(base)).filter(n => n.endsWith(`-${engine}`)).sort().at(-1);
const out = path.join(base, `${new Date().toISOString().replaceAll(':', '-')}-${engine}${screenshots ? '' : '-layout'}`);
await mkdir(out);
const scenarios = (await readdir(path.join(root, 'tooling/acceptance/scenarios'))).filter(f => f.endsWith('.json') && (!scenarioFilter || f === `${scenarioFilter}.json`)).sort();
if (!scenarios.length) throw new Error('No matching acceptance scenario');
const report = { engine, screenshots, previous: screenshots ? previous ?? null : null, viewports: [{ width: 640, height: 800 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }], scenarios: [], failures: [] };
// This server has no production owner dependency: fixture API calls are intercepted
// in the dev-only module, and the browser rejects every real management request.
const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await ({ chromium, webkit }[engine]).launch();
  for (const file of scenarios) {
    const fixture = JSON.parse(await readFile(path.join(root, 'tooling/acceptance/scenarios', file), 'utf8'));
    const setup = !!(fixture.sourceSetup && fixture.sourceSetup.step !== 'welcome' || fixture.connectionSetup);
    if (setupOnly && !setup) continue;
    for (const { width, height } of report.viewports) {
      const name = file.slice(0, -5), key = `${name}-${width}x${height}`;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', route => { errors.push(`Unexpected live API: ${route.request().url()}`); return route.abort(); });
      // Stable elapsed labels across runs, while rAF and the renderer keep working.
      await page.addInitScript(() => { const original = Date; const fixed = original.parse('2026-01-01T00:00:00Z'); Date = class extends original { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }; });
      const row = { name, width, height, key, errors, baseline: screenshots ? 'missing' : 'disabled', changedPixels: null, changedRatio: null };
      try {
        await page.goto(`http://127.0.0.1:${port}/?scenario=${encodeURIComponent(name)}`);
        await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, name, { timeout: 15000 });
        const model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
        if (!model.scenario?.ready) throw new Error(model.scenario?.error || 'Fixture task detail is not ready');
        if (!fixture.page && !model.topology) throw new Error('No rendered topology exported');
        const actualAgents = (model.topology?.nodes ?? []).filter(n => n.side === 1).map(n => n.id);
        if (!fixture.page && fixture.agents.some(a => !actualAgents.includes(a))) throw new Error('Fixture agents were not rendered');
        const representedTasks = model.topology?.tasks.reduce((sum, task) => sum + (task.count ?? 1), 0);
        if (!fixture.page && !fixture.panel && representedTasks !== fixture.tasks.length) throw new Error(`Task count mismatch: ${representedTasks}/${fixture.tasks.length}`);
        if (fixture.panel?.kind === 'agent' && model.panels.agent?.agent !== fixture.panel.id) throw new Error('Agent panel not opened');
        if (fixture.panel?.kind === 'source' && model.panels.source !== fixture.panel.id) throw new Error('Source panel not opened');
        if (name === 'task-states' || name === 'task-review-unavailable' || name === 'dispatch-states') {
          // Regression: activity disappearance and unrelated review failures changed execution results.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          if (name === 'task-review-unavailable') {
            const panel = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
            await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
            if (await panel.getByRole('alert').count()) throw new Error('Review was loaded before requesting supplementary information');
            await panel.getByRole('button', { name: messages['detail.reviewInfo'], exact: true }).click();
            await panel.getByText(messages['detail.reviewUnavailable'], { exact: true }).waitFor();
            await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
            const view = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
            if (view.taskDetail?.state && view.taskDetail.state !== 'done') throw new Error('Review availability changed execution state');
          }
          if (name === 'task-states') {
            const panel = page.getByRole('dialog', { name: 'Codex', exact: true });
            const expected = ['running', 'needsYou', 'done', 'failed', 'interrupted', 'unknown'];
            for (const [index, state] of expected.entries()) {
              const button = panel.getByRole('button', { name: new RegExp(`^${fixture.tasks[index].title} ·`) });
              await button.waitFor();
              if (!await button.getByText(messages[`detail.state.${state}`], { exact: true }).count() && state !== 'running') throw new Error(`Missing ${state} execution state`);
            }
          }
          if (name === 'dispatch-states') {
            await page.getByRole('button', { name: /Earlier completed dispatch/ }).getByText(messages['detail.state.done'], { exact: true }).waitFor();
            await page.getByRole('button', { name: /Current running dispatch/ }).getByText(messages['detail.state.running'], { exact: true }).waitFor();
            await page.getByRole('button', { name: /Submission awaiting-approval/ }).getByText(messages['sourcePanel.awaitingApproval'], { exact: true }).waitFor();
            await page.getByRole('button', { name: /Submission reserved/ }).getByText(messages['sourcePanel.submitting'], { exact: true }).waitFor();
            await page.getByRole('button', { name: /Earlier completed dispatch/ }).click();
            await page.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
            await page.getByText(messages['detail.selectedTurn'].replace('{count}', '1'), { exact: true }).waitFor();
          }
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-states.png`), animations: 'disabled' });
        }
        if (fixture.metadataOnlyHistory) {
          // Regression: opening and paging history prefetched one full timeline per row and stalled list rendering.
          const started = performance.now();
          for (const count of [20, 40, 60]) {
            const row = page.getByRole('button', { name: new RegExp(`^Review project change ${count} ·`) });
            await row.waitFor();
            await row.scrollIntoViewIfNeeded();
          }
          row.historyPaginationMs = Math.round(performance.now() - started);
          await page.getByRole('button', { name: /^Review project change 1 ·/ }).scrollIntoViewIfNeeded();
        }
        if (name === 'agent-panel-unread') {
          // Regression: completed unread tasks were mixed into date groups instead of appearing between Running and Today.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const panel = page.getByRole('dialog', { name: 'Codex', exact: true });
          const unread = panel.getByRole('region', { name: messages['agentPanel.unread'], exact: true });
          const today = panel.getByRole('region', { name: messages['agentPanel.today'], exact: true });
          await unread.waitFor({ state: 'visible' });
          await today.waitFor({ state: 'visible' });
          const sections = await panel.getByRole('region').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
          const runningIndex = sections.indexOf(messages['agentPanel.running']);
          if (runningIndex < 0 || sections[runningIndex + 1] !== messages['agentPanel.unread'] || sections[runningIndex + 2] !== messages['agentPanel.today']) throw new Error('Unread is not between Running and Today');
          const completed = fixture.tasks.filter(task => task.completed);
          if (await unread.getByRole('button').count() !== completed.length) throw new Error('Unread group count does not match observed unread completions');
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-unread.png`), animations: 'disabled' });
          for (const task of completed) {
            const name = new RegExp(`^${task.title} ·`);
            if (await today.getByRole('button', { name }).count()) throw new Error('Unread task is duplicated in Today');
            await unread.getByRole('button', { name }).click();
            await page.getByRole('button', { name: messages.back, exact: true }).click();
            await today.getByRole('button', { name }).waitFor({ state: 'visible' });
            await unread.getByRole('button', { name }).waitFor({ state: 'hidden' });
          }
          await unread.waitFor({ state: 'hidden' });
        }
        if (name === 'task-queue-overflow') {
          // Regression: overflow hid running tasks, and View all opened the Agent panel instead of temporarily revealing the queue.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const summary = page.getByRole('button', { name: new RegExp(`${messages['activity.viewAll']}$`) });
          const taskButton = task => page.getByRole('button', { name: new RegExp(`^${task.title} ·`) });
          for (const task of fixture.tasks.filter(task => !task.completed)) {
            if (!await taskButton(task).isVisible()) throw new Error('Overflow hid unfinished work behind completed tasks');
          }
          await summary.click();
          for (const task of fixture.tasks) await taskButton(task).waitFor({ state: 'visible' });
          const expanded = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
          if (expanded.panels.agent || expanded.panels.source || await page.getByRole('dialog').count()) throw new Error('View all opened a detail panel');
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-expanded.png`), animations: 'disabled' });
          await page.keyboard.press('Escape');
          await summary.waitFor({ state: 'visible' });
          await taskButton(fixture.tasks[1]).waitFor({ state: 'hidden' });
          if (!await summary.evaluate(element => element === document.activeElement)) throw new Error('Escape did not restore overflow trigger focus');
          await summary.press('Enter');
          for (const task of fixture.tasks) await taskButton(task).waitFor({ state: 'visible' });
          if (!await taskButton(fixture.tasks[1]).evaluate(element => element === document.activeElement)) throw new Error('Keyboard expansion did not focus a revealed task');
          await page.getByRole('main').click({ position: { x: 1, y: 1 } });
          await summary.waitFor({ state: 'visible' });
          await taskButton(fixture.tasks[1]).waitFor({ state: 'hidden' });
        }
        if (fixture.detailTask !== undefined) {
          // Semantic snapshots exclude aria-hidden Radix form inputs and visual announcement mirrors.
          row.taskAccessibility = await page.getByRole('dialog', { name: fixture.tasks[fixture.detailTask].title, exact: true }).ariaSnapshot();
        }
        if (setup) {
          // Regression: standard setup steps scrolled inside a fixed 496px shell on large windows.
          const layout = await page.evaluate(() => {
            const dialogs = [...document.querySelectorAll('.setup-dialog:has(.setup-steps)')];
            return dialogs.map(dialog => {
              const rect = dialog.getBoundingClientRect(), body = dialog.querySelector('.dialog-body');
              const tiles = [...dialog.querySelectorAll('.choice-tiles .choice-radio')].map(grid => [...grid.children].map(tile => {
                const r = tile.getBoundingClientRect(); return { width: r.width, top: r.top };
              }));
              return { recessed: dialog.hasAttribute('data-recessed'), stacked: !!dialog.querySelector('.setup-return'),
                x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width,
                scroll: body.scrollHeight - body.clientHeight, horizontalScroll: body.scrollWidth - body.clientWidth, tiles };
            });
          });
          row.layout = layout;
          if (!layout.length) throw new Error('Setup dialog was not rendered');
          for (const dialog of layout.filter(d => !d.recessed)) {
            if (dialog.x < 0 || dialog.y < 0 || dialog.right > width || dialog.bottom > height) throw new Error('Setup dialog exceeds the viewport');
            if (dialog.horizontalScroll > 1) throw new Error('Setup content scrolls horizontally');
            if (width >= 1280 && dialog.scroll > 1) throw new Error(`Standard setup step scrolls by ${dialog.scroll}px`);
            for (const tiles of dialog.tiles) {
              if (tiles.length >= 3 && (Math.abs(tiles[0].width - tiles[1].width) > 1 || Math.abs(tiles[1].width - tiles[2].width) > 1 || tiles[0].top !== tiles[2].top)) throw new Error('Platform grid is not three equal columns');
            }
            if (dialog.stacked && !layout.some(parent => parent.recessed && parent.width > dialog.width)) throw new Error('Stacked dialog is not narrower than its parent');
          }
        }
        if (fixture.update) {
          // Regression: update work groups and restart progress were hidden behind modal dialogs.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          if (fixture.page === 'settings') {
            await page.getByRole('heading', { name: messages.aboutApp, exact: true }).waitFor({ state: 'visible' });
          } else if (['succeeded', 'rolled-back', 'failed', 'cancelled'].includes(fixture.update.state)) {
            const key = fixture.update.state === 'failed' && fixture.update.backupMoved ? 'updates.restoreFailed' : `updates.state.${fixture.update.state}`;
            await page.getByText(messages[key], { exact: true }).waitFor({ state: 'visible' });
          } else {
            const entry = page.getByRole('button', { name: messages.viewUpdate, exact: true });
            await entry.waitFor({ state: 'visible' });
            if (fixture.updatePanel === false) await entry.click();
            const panel = page.getByRole('dialog', { name: messages.appUpdates, exact: true });
            await panel.waitFor({ state: 'visible' });
            if (fixture.update.state === 'settling') {
              for (const group of ['blocking', 'willResume', 'unaffected']) await panel.getByRole('region', { name: messages[`updates.${group}`], exact: true }).waitFor({ state: 'visible' });
            }
            if (fixture.update.state === 'countdown') await panel.getByRole('list', { name: messages['updates.progress'] }).waitFor({ state: 'visible' });
          }
        }
        if (name === 'accounts') {
          // Regression: account management was only reachable through Settings and hid source identities.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await page.getByRole('heading', { name: messages['accounts.title'], exact: true }).waitFor({ state: 'visible' });
          await page.getByRole('textbox', { name: messages['accounts.alias'], exact: true }).waitFor({ state: 'visible' });
          await page.getByRole('button', { name: messages['accounts.add'], exact: true }).click();
          const dialog = page.getByRole('dialog', { name: messages['accounts.add'], exact: true });
          await dialog.waitFor({ state: 'visible' });
          await dialog.getByRole('button', { name: messages['accounts.next'], exact: true }).click();
          await dialog.getByRole('button', { name: messages['accounts.signin'], exact: true }).click();
          await dialog.getByRole('textbox', { name: messages['accounts.alias'], exact: true }).waitFor({ state: 'visible' });
          await dialog.getByRole('button', { name: messages['accounts.confirm'], exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
        }

        await writeFile(path.join(out, `${key}.json`), JSON.stringify(model, null, 2));
        if (screenshots) {
          const buffer = await page.screenshot({ path: path.join(out, `${key}.png`), animations: 'disabled' });
          if (previous) {
            let baseline;
            try { baseline = await readFile(path.join(base, previous, `${key}.png`)); } catch { /* New scenario. */ }
            if (baseline) {
              const before = PNG.sync.read(baseline), after = PNG.sync.read(buffer);
              await writeFile(path.join(out, `${key}-before.png`), baseline);
              if (before.width === after.width && before.height === after.height) {
                const diff = new PNG({ width: after.width, height: after.height });
                row.changedPixels = pixelmatch(before.data, after.data, diff.data, after.width, after.height, { threshold: 0.1 });
                row.changedRatio = row.changedPixels / (after.width * after.height);
                row.baseline = row.changedPixels ? 'changed' : 'unchanged';
                await writeFile(path.join(out, `${key}-diff.png`), PNG.sync.write(diff));
              } else row.baseline = 'dimensions-changed';
            }
          }
        }
        if (width >= 1280 && !fixture.panel && fixture.tasks.some(task => task.completed)) {
          // Regression: dragging a completed card left a click guard that swallowed its mark-read action.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          for (const task of fixture.tasks.filter((task, index) => task.completed && model.topology.tasks.some(row => row.taskId === `fixture-task-${index}`))) {
            const bubble = page.getByRole('button').filter({ has: page.getByText(task.title, { exact: true }) });
            const bounds = await bubble.boundingBox();
            if (!bounds) throw new Error('Completed task is unavailable for mark-read acceptance');
            await bubble.dragTo(bubble, {
              sourcePosition: { x: bounds.width / 2, y: bounds.height / 2 },
              targetPosition: { x: bounds.width * 0.6, y: bounds.height * 0.6 },
            });
            const markRead = page.getByRole('button', { name: messages['activity.markRead'], exact: true });
            await markRead.click();
            await bubble.getByRole('img', { name: messages['activity.unread'], exact: true }).waitFor({ state: 'hidden' });
            if (await page.getByRole('dialog').count()) throw new Error('Mark-read opened a task detail panel');
          }
        }
      } catch (error) { errors.push(String(error)); }
      if (errors.length) report.failures.push(key);
      report.scenarios.push(row);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>ARC UI acceptance</title><style>body{font:14px system-ui;background:#eee;color:#222;margin:24px}section{background:white;padding:16px;margin:16px 0;border-radius:12px}figure{margin:0}img{width:100%;border:1px solid #ccc} .images{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.changed{border-left:6px solid #d88b00}code{white-space:pre-wrap}</style><h1>ARC UI acceptance · ${engine}</h1><p>Previous: ${escape(report.previous ?? (screenshots ? 'none — first run has no baseline' : 'screenshots disabled'))} · failures: ${report.failures.length}</p>${report.scenarios.map(r => `<section class="${r.baseline.includes('changed') && r.baseline !== 'unchanged' ? 'changed' : ''}"><h2>${escape(r.key)} · ${r.baseline} ${r.changedPixels ?? ''}</h2>${r.errors.length ? `<code>${escape(r.errors.join('\n'))}</code>` : ''}${screenshots ? `<div class="images">${r.baseline !== 'missing' ? `<figure><figcaption>Previous</figcaption><img src="${r.key}-before.png"></figure>` : ''}<figure><figcaption>Current</figcaption><a href="${r.key}.png"><img src="${r.key}.png"></a></figure>${r.changedPixels !== null ? `<figure><figcaption>Pixel diff (${(r.changedRatio * 100).toFixed(3)}%)</figcaption><img src="${r.key}-diff.png"></figure>` : ''}</div>` : '<p>Screenshots disabled; layout measurements are in report.json.</p>'}<a href="${r.key}.json">View model</a></section>`).join('')}`);
console.log(JSON.stringify({ ok: !report.failures.length, directory: out, report: path.join(out, 'index.html'), failures: report.failures }));
process.exitCode = report.failures.length ? 1 : 0;

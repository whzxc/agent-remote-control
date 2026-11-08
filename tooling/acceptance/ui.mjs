import { verifyCoordination } from './coordination.mjs';
import { verifyPortraitTopology } from './portrait-topology.mjs';
import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { runTestCommand } from '../test.mjs';

if (process.argv.includes('--task-dock')) {
  await runTestCommand(process.execPath, ['tooling/check-tests.mjs']);
  await runTestCommand(process.execPath, ['--test', 'tests/task-dock-layout.test.ts']);
  process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) ?? path.join(root, 'output/acceptance/ui'));
const screenshots = !process.argv.includes('--no-screenshots');
const scenarioFilter = process.argv.find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length);
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice('--port='.length) ?? 5187);
const setupOnly = process.argv.includes('--setup-only');
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Picks a model from the picker's nested menu and, when given, moves the effort slider to that step.
async function chooseSpec(page, messages, model, effort) {
  await page.getByRole('button', { name: new RegExp(`^${escapeRegex(messages['dispatchDefaults.model'])}: `) }).click();
  await page.getByRole('menuitemradio', { name: model, exact: true }).click();
  await page.getByRole('button', { name: `${messages['dispatchDefaults.model']}: ${model}`, exact: true }).waitFor();
  if (!effort) return;
  const slider = page.getByRole('slider', { name: messages['dispatchDefaults.effort'] });
  await slider.focus();
  await slider.press('End');
  await page.locator(`[role=slider][aria-valuetext="${effort}"]`).waitFor();
}
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
    for (const { width, height } of fixture.viewports ?? report.viewports) {
      const name = file.slice(0, -5), key = `${name}-${width}x${height}`;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US',
        timezoneId: fixture.timezone ?? (name.startsWith('portrait-topology-') ? 'Asia/Shanghai' : undefined) });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', route => { errors.push(`Unexpected live API: ${route.request().url()}`); return route.abort(); });
      // Stable elapsed labels across runs, while rAF and the renderer keep working.
      await page.addInitScript(clock => { const original = Date; const fixed = original.parse(clock); Date = class extends original { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }; }, fixture.clock ?? '2026-01-01T00:00:00Z');
      const row = { name, width, height, key, errors, baseline: screenshots ? 'missing' : 'disabled', changedPixels: null, changedRatio: null };
      try {
        await page.goto(`http://127.0.0.1:${port}/${fixture.browser ? 'browser.html' : ''}?scenario=${encodeURIComponent(name)}${fixture.browser ? '&key=arc_fixture_browser_key' : ''}`);
        await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, name, { timeout: 15000 });
        if (name.startsWith('agent-settings-')) {
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await page.getByRole('button', { name: new RegExp(`${escapeRegex(messages.manageAgents)}|${escapeRegex(messages.addAgent)}`) }).click();
          if (fixture.agentDisplay) {
            await page.getByRole('button', { name: messages.agentDisplaySettings, exact: true }).click();
            const density = page.getByRole('radiogroup', { name: messages['activity.density'], exact: true });
            if (await density.count()) {
              const standard = density.getByRole('radio', { name: messages['activity.density.standard'], exact: true });
              await standard.press('ArrowRight', { delay: 50 });
              await density.getByRole('radio', { name: messages['activity.density.detailed'], exact: true, checked: true }).waitFor({ timeout: 3000 });
              await density.getByRole('radio', { name: messages['activity.density.detailed'], exact: true }).press('ArrowLeft', { delay: 50 });
              await density.getByRole('radio', { name: messages['activity.density.standard'], exact: true, checked: true }).waitFor({ timeout: 3000 });
            } else {
              const trigger = page.getByRole('combobox', { name: messages['activity.density'], exact: true });
              await trigger.press('Enter');
              await page.getByRole('option', { name: messages['activity.density.detailed'], exact: true }).click();
              await trigger.press('Enter');
              await page.getByRole('option', { name: messages['activity.density.standard'], exact: true }).click();
              if (!await trigger.evaluate(element => element === document.activeElement)) throw new Error('Density menu did not restore trigger focus.');
            }
          }
          if (fixture.agentDetail) {
            await page.getByRole('button', { name: 'Codex', exact: true }).first().click();
            await page.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true }).click();
            await chooseSpec(page, messages, 'GPT-6.1 Sol', messages['dispatchSpec.effort.max']);
            if (screenshots) await page.screenshot({ path: path.join(out, `${key}-effort.png`), animations: 'disabled' });
            // An effort the newly selected model does not support falls back to the Agent default.
            await chooseSpec(page, messages, 'GPT-5.6 Sol');
            await page.locator(`[role=slider][aria-valuetext="${messages['dispatchDefaults.inherit']}"]`).waitFor();
            await page.keyboard.press('Escape');
          }
        }
        if (fixture.agentDisplay || fixture.page === 'settings') {
          const settings = page.locator('.settings-stack').last();
          await settings.waitFor();
          const issues = await settings.evaluate(root => [...root.querySelectorAll('.setting')].flatMap(row => {
            const copy = row.querySelector('.setting-copy').getBoundingClientRect();
            const control = row.querySelector('.setting-control').getBoundingClientRect();
            return copy.right > control.left || row.scrollWidth > row.clientWidth + 1
              ? [row.textContent.trim()] : [];
          }));
          if (issues.length) throw new Error(`Settings rows overlap or overflow: ${issues.join('; ')}`);
        }
        let model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
        if (!model.scenario?.ready) throw new Error(model.scenario?.error || 'Fixture task detail is not ready');
        if (fixture.browser) {
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          if (new URL(page.url()).searchParams.has('key')) throw new Error('Browser retained the access key in its URL');
          if (!await page.evaluate(() => Object.values(localStorage).includes('arc_fixture_browser_key'))) throw new Error('Browser did not retain the access key');
          if (await page.getByRole('banner').count()) throw new Error('Browser added a separate status header');
          await page.getByRole('button', { name: messages.manageAgents, exact: true }).click();
          await page.getByRole('dialog', { name: messages.agents, exact: true }).waitFor();
          const switches = page.getByRole('dialog', { name: messages.agents, exact: true }).getByRole('switch');
          for (const toggle of await switches.all()) if (!await toggle.isDisabled()) throw new Error('Browser exposed an Agent write control');
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
          if (await page.getByRole('button', { name: messages.settings, exact: true }).count()) throw new Error('Browser exposed desktop settings');
          const power = page.getByRole('button', { name: messages['hub.stop'], exact: true });
          if (await power.count()) throw new Error('Browser exposed ingress controls');
          await page.getByRole('button', { name: messages.addControlSource, exact: true }).click();
          await page.getByRole('dialog').waitFor();
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
          await page.getByRole('button', { name: /^Codex: / }).click();
          await page.getByRole('dialog').waitFor();
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-agent.png`) });
          const task = page.getByRole('dialog').getByRole('button', { name: new RegExp(escapeRegex(fixture.tasks[0].title)) }).first();
          await task.click();
          await page.getByRole('dialog').waitFor();
          await page.getByRole('dialog').getByText('npm run check', { exact: true }).waitFor();
          for (const input of await page.getByRole('dialog').getByRole('textbox').all()) if (await input.isEnabled()) throw new Error('Browser exposed a task composer');
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-conversation.png`) });
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
        }
        if (!fixture.page && !model.topology) throw new Error('No rendered topology exported');
        const actualAgents = (model.topology?.nodes ?? []).filter(n => n.side === 1).map(n => n.id);
        if (!fixture.page && fixture.agents.some(a => !actualAgents.includes(a))) throw new Error('Fixture agents were not rendered');
        const representedTasks = model.topology?.tasks.reduce((sum, task) => sum + (task.count ?? 1), 0);
        if (!fixture.page && !fixture.panel && representedTasks !== fixture.tasks.length) throw new Error(`Task count mismatch: ${representedTasks}/${fixture.tasks.length}`);
        if (name.startsWith('portrait-topology-')) {
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await verifyPortraitTopology(page, fixture, messages, out, key, screenshots);
          model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
        }
        if (fixture.panel?.kind === 'agent' && model.panels.agent?.agent !== fixture.panel.id) throw new Error('Agent panel not opened');
        if (fixture.panel?.kind === 'source' && model.panels.source !== fixture.panel.id) throw new Error('Source panel not opened');
        if (fixture.coordination) {
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          row.coordination = await verifyCoordination(page, fixture, messages, out, key, screenshots);
        }
        if (fixture.settingsExtras) {
          // Regression: experimental pets were exposed as a primary navigation page.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await page.getByRole('radio', { name: messages['topology.experimental'] }).click();
          const pets = page.getByRole('switch', { name: messages['pets.show'], exact: true });
          const studio = page.getByRole('switch', { name: messages['studio.enabled'], exact: true });
          if (await pets.isChecked() !== !!fixture.pets || await studio.isChecked() !== !!fixture.studio) throw new Error('Experimental defaults differ from fixture preferences');
          await pets.click();
          await pets.click();
        }
        if (fixture.studio && !fixture.coordination) {
          // Regression: changing studio lighting must not replace the saved application theme.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const settings = page.getByRole('button', { name: messages['studio.settings'], exact: true });
          await page.getByTitle(messages['studio.clock'], { exact: true }).waitFor({ state: 'visible' });
          await settings.click();
          const phase = fixture.studio === 'night' ? 'day' : 'night';
          await page.getByRole('radio', { name: messages[`studio.${phase}`], exact: true }).click();
          await page.waitForFunction(expected => window.__ARC_VIEW_MODEL__().theme === expected, phase === 'day' ? 'light' : 'dark');
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: messages.settings, exact: true }).click();
          await page.getByRole('button', { name: messages['topology.experimental'], exact: true }).click();
          const enabled = page.getByRole('switch', { name: messages['studio.enabled'], exact: true });
          await enabled.click();
          await page.waitForFunction(expected => window.__ARC_VIEW_MODEL__().theme === expected, fixture.theme);
          await enabled.click();
          await page.getByRole('button', { name: messages.backToHome, exact: true }).click();
          await settings.click();
          await page.getByRole('radio', { name: messages[`studio.${fixture.studio}`], exact: true }).click();
          await page.keyboard.press('Escape');
          await settings.waitFor({ state: 'visible' });
        }
        if (name === 'studio-connections' || name === 'studio-stopped') {
          // Regression: moving ingress control into the mark must preserve both pointer and keyboard activation.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const initiallyRunning = fixture.ingressStates.some(state => state === 'ready');
          const action = page.getByRole('button', { name: messages[initiallyRunning ? 'hub.stop' : 'hub.start'], exact: true });
          if (await action.getAttribute('aria-pressed') !== String(initiallyRunning)) throw new Error('Ingress control did not expose the current running state');
          await page.mouse.move(0, 0);
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-power-default.png`) });
          await action.hover();
          const powerGlyph = action.locator('.hub-power-action');
          await powerGlyph.hover();
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-power-hover.png`) });
          await page.mouse.move(0, 0);
          await page.keyboard.press('Tab');
          await action.focus();
          if (screenshots) await page.screenshot({ path: path.join(out, `${key}-power-focus.png`) });
          await action.press('Tab');
          await action.hover();
          await powerGlyph.click();
          await action.and(page.locator('[aria-busy="true"]')).waitFor({ state: 'visible' });
          const next = page.getByRole('button', { name: messages[initiallyRunning ? 'hub.start' : 'hub.stop'], exact: true });
          await next.and(page.locator('[aria-busy="false"][aria-disabled="false"]')).waitFor({ state: 'visible' });
          if (await next.getAttribute('aria-pressed') !== String(!initiallyRunning)) throw new Error('Ingress control did not settle after pointer activation');
          await next.press('Enter');
          await action.waitFor({ state: 'visible' });
          await action.and(page.locator('[aria-busy="false"][aria-disabled="false"]')).waitFor({ state: 'visible' });
          if (await action.getAttribute('aria-pressed') !== String(initiallyRunning)) throw new Error('Ingress control did not settle after keyboard activation');
          if (await page.getByRole('dialog').count()) throw new Error('Ingress activation unexpectedly opened a connection or Agent dialog');
          await page.reload();
          await page.waitForFunction(name => document.documentElement.dataset.scenarioReady === name, name);
        }
        if (name === 'studio-unavailable') {
          // Regression: an unavailable status must not permit an optimistic ingress toggle.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const action = page.getByRole('button', { name: messages['hub.stop'], exact: true });
          if (await action.getAttribute('aria-disabled') !== 'true') throw new Error('Unavailable ingress control remained actionable');
          await action.press('Enter');
          if (await action.getAttribute('aria-disabled') !== 'true' || await action.getAttribute('aria-busy') !== 'false') throw new Error('Unavailable ingress control started an operation');
        }
        if (name === 'antigravity-task') {
          // Regression: Antigravity replies and denied actions disappeared from completed task details.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const task = fixture.tasks[0];
          const panel = page.getByRole('dialog', { name: task.title, exact: true });
          await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
          await panel.getByText(task.entries.find(entry => entry.phase === 'final_answer').text, { exact: true }).waitFor();
          await panel.getByRole('button', { name: new RegExp(`^${escapeRegex(messages['detail.process'].split('{')[0])}`) }).click();
          for (const entry of task.entries.filter(entry => entry.type === 'error')) {
            await panel.getByText(entry.text, { exact: true }).waitFor();
          }
          await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
        }
        if (name === 'task-states' || name === 'task-review-unavailable' || name === 'dispatch-states') {
          // Regression: activity disappearance and unrelated review failures changed execution results.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          if (name === 'task-review-unavailable') {
            const panel = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
            await panel.getByRole('status').filter({ hasText: messages['detail.state.done'] }).waitFor();
            const reviewFailure = panel.getByRole('alert');
            await reviewFailure.waitFor();
            if (!(await reviewFailure.innerText()).includes(messages['detail.reviewUnavailable'])) throw new Error('Review read failure was not reported');
            await reviewFailure.getByRole('button', { name: messages.retry, exact: true }).click();
            await reviewFailure.waitFor();
            await reviewFailure.getByRole('button', { name: messages.retry, exact: true }).waitFor();
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
        if (name === 'dispatch-spec') {
          const [three, five, historical] = fixture.tasks.map(task => page.getByRole('group', { name: task.title, exact: true }));
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await three.getByRole('img', { name: new RegExp(`Example Three.*${messages['dispatchSpec.effort.medium']}.*${messages['activity.fast']}`) }).waitFor();
          await five.getByRole('img', { name: new RegExp(`Example Five.*${messages['dispatchSpec.effort.high']}`) }).waitFor();
          if (await five.getByRole('img', { name: new RegExp(messages['activity.fast']) }).count()) throw new Error('Default service tier displayed Fast');
          await historical.getByText(fixture.tasks[2].spec.effort, { exact: true }).waitFor();
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
        if (fixture.taskRelationships) {
          const { verifyTaskRelationships } = await import('./task-relationships.mjs');
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await verifyTaskRelationships(page, fixture, messages, out, key, screenshots);
        }
        if (fixture.detailTask !== undefined) {
          const task = fixture.tasks[fixture.detailTask];
          if (task.parent !== undefined) {
            // Regression: a detail scenario exposed faded queue buttons behind its panel instead of limiting interaction to the panel.
            const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
            const detail = page.getByRole('dialog', { name: task.title, exact: true });
            if (await page.locator('.activity-slot').getByRole('button').count()) throw new Error('The replaced task queue remains accessible behind the detail panel');
            const parent = fixture.tasks[task.parent];
            await detail.getByRole('button', { name: `${messages['activity.parentThread']} ${parent.title}`, exact: true }).click();
            await page.waitForFunction(id => window.__ARC_VIEW_MODEL__().panels.agent?.session?.id === id, `fixture-task-${task.parent}`);
            await page.getByRole('dialog', { name: parent.title, exact: true }).waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('dialog').waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: new RegExp(`^${escapeRegex(task.title)} · ${escapeRegex(messages[`activity.relation.${task.relationKind ?? 'subagent'}`])} ·`) }).click();
            await page.waitForFunction(id => window.__ARC_VIEW_MODEL__().panels.agent?.session?.id === id, `fixture-task-${fixture.detailTask}`);
            await detail.waitFor();
          }
          // Semantic snapshots exclude aria-hidden Radix form inputs and visual announcement mirrors.
          row.taskAccessibility = await page.getByRole('dialog', { name: fixture.tasks[fixture.detailTask].title, exact: true }).ariaSnapshot();
        }
        if (fixture.taskModelChoice) {
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          await page.getByRole('button', { name: messages['taskDispatch.title'], exact: true }).click();
          const dialog = page.getByRole('dialog', { name: messages['taskDispatch.title'], exact: true });
          await dialog.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true }).click();
          await chooseSpec(page, messages, 'GPT-6.1 Sol', messages['dispatchSpec.effort.max']);
          // Escape closes the picker first, then the dialog, restoring the task detail it was opened from.
          await page.keyboard.press('Escape');
          await page.getByRole('dialog', { name: messages['dispatchDefaults.spec'], exact: true }).waitFor({ state: 'hidden' });
          // The next Escape belongs to the task dialog once focus returns to the picker trigger.
          await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, messages['dispatchDefaults.spec']);
          await page.keyboard.press('Escape');
          await page.getByRole('dialog', { name: fixture.tasks[fixture.detailTask].title, exact: true }).waitFor();
          await page.getByRole('button', { name: messages['taskDispatch.title'], exact: true }).click();
          await dialog.getByRole('button', { name: messages['dispatchDefaults.spec'], exact: true })
            .getByRole('img', { name: new RegExp(`GPT-6\\.1 Sol.*${escapeRegex(messages['dispatchSpec.effort.max'])}`) }).waitFor();
          await page.keyboard.press('Escape');
        }
        if (setup) {
          // Regression: a fixed 496px shell scrolled before using the available viewport height.
          const layout = await page.getByRole('dialog', { includeHidden: true }).evaluateAll(dialogs => {
            return dialogs.filter(dialog => dialog.querySelector('.setup-steps')).map(dialog => {
              const rect = dialog.getBoundingClientRect(), body = dialog.querySelector('.dialog-body');
              const viewportMargin = Number.parseFloat(getComputedStyle(dialog).getPropertyValue('--setup-viewport-margin'));
              const tiles = [...dialog.querySelectorAll('.choice-tiles .choice-radio')].map(grid => [...grid.children].map(tile => {
                const r = tile.getBoundingClientRect(); return { width: r.width, top: r.top };
              }));
              return { recessed: dialog.hasAttribute('data-recessed'), stacked: !!dialog.querySelector('.setup-return'),
                x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
                growthRoom: innerHeight - viewportMargin - rect.height,
                scroll: body.scrollHeight - body.clientHeight, horizontalScroll: body.scrollWidth - body.clientWidth, tiles };
            });
          });
          row.layout = layout;
          if (!layout.length) throw new Error('Setup dialog was not rendered');
          for (const dialog of layout.filter(d => !d.recessed)) {
            if (dialog.x < 0 || dialog.y < 0 || dialog.right > width || dialog.bottom > height) throw new Error('Setup dialog exceeds the viewport');
            if (dialog.horizontalScroll > 1) throw new Error('Setup content scrolls horizontally');
            if (dialog.scroll > 1 && dialog.growthRoom > 1) throw new Error(`Setup body scrolls by ${dialog.scroll}px with ${dialog.growthRoom}px of unused viewport height`);
            for (const tiles of dialog.tiles) {
              if (tiles.length >= 3 && (Math.abs(tiles[0].width - tiles[1].width) > 1 || Math.abs(tiles[1].width - tiles[2].width) > 1 || tiles[0].top !== tiles[2].top)) throw new Error('Platform grid is not three equal columns');
            }
            if (dialog.stacked && !layout.some(parent => parent.recessed && parent.width > dialog.width)) throw new Error('Stacked dialog is not narrower than its parent');
          }
        }
        if (fixture.update && !fixture.coordination) {
          // Regression: downloaded updates must expose a direct restart action.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          if (fixture.page === 'settings') {
            await page.getByRole('heading', { name: messages.aboutApp, exact: true }).waitFor({ state: 'visible' });
          } else {
            const entry = page.getByRole('button', { name: messages.viewUpdate, exact: true });
            await entry.waitFor({ state: 'visible' });
            if (fixture.updatePanel === false) await entry.click();
            const panel = page.getByRole('dialog', { name: messages.appUpdates, exact: true });
            await panel.waitFor({ state: 'visible' });

          }
        }
        if (name === 'accounts') {
          // Regression: the accounts fixture targeted retired UI and matched both hub and Platforms add-source buttons.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const platforms = page.getByRole('region', { name: messages['platforms.title'], exact: true });
          await platforms.getByRole('heading', { name: messages['platforms.title'], exact: true }).waitFor({ state: 'visible' });
          const source = await page.evaluate(async () => {
            // Vite serves ui/ at the browser root.
            const { scenarioResponse } = await import('/scenarios.ts');
            const { controlSource } = await import('/controlSources.ts');
            const source = scenarioResponse('source', 'GET').sources.find(source => source.product === 'chatgpt');
            if (!source?.authorizationFacts?.email) throw new Error('Account fixture is missing its connected source identity');
            return { label: source.label, email: source.authorizationFacts.email, productName: controlSource(source.product).displayName };
          });
          const card = platforms.getByRole('region', { name: source.label, exact: true });
          await card.getByRole('heading', { name: source.label, exact: true }).waitFor({ state: 'visible' });

          // Regression: AX-26 copying a selection spanning an ordinary label and masked identity discarded the label.
          // Sensitive preserves @ in email stand-ins and labels its outer span with accounts.hidden.
          const identity = card.getByRole('definition').filter({ hasText: /@/ }).getByLabel(messages['accounts.hidden'], { exact: true });
          const standIn = await identity.innerText();
          if (!standIn || standIn === source.email) throw new Error('Account identity is not privacy-masked');
          const copied = await page.evaluate(({ label, identity }) => {
            const selection = window.getSelection(), range = document.createRange();
            range.setStartBefore(label); range.setEndAfter(identity);
            selection.removeAllRanges(); selection.addRange(range);
            try {
              const selected = selection.toString(), clipboard = new DataTransfer();
              clipboard.setData('text/plain', selected);
              const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard });
              identity.dispatchEvent(event);
              return { selected, text: clipboard.getData('text/plain'), handled: event.defaultPrevented };
            } finally { selection.removeAllRanges(); }
          }, { label: await card.getByText(messages['platforms.email'], { exact: true }).elementHandle(), identity: await identity.elementHandle() });
          if (!copied.selected.includes(messages['platforms.email']) || !copied.selected.includes(standIn)) throw new Error('Copy selection does not span ordinary text and the masked identity');
          if (!copied.handled || !copied.text.includes(messages['platforms.email']) || !copied.text.includes(source.email) || copied.text.includes(standIn)) throw new Error('Mixed account copy lost ordinary text or failed to restore the real fixture identity');

          await card.getByRole('button', { name: messages['platforms.rename'].replace('{name}', source.label), exact: true }).click();
          const renamed = `${source.label} fixture`;
          await card.getByRole('textbox', { name: messages['platforms.name'], exact: true }).fill(renamed);
          await card.getByRole('button', { name: messages.save, exact: true }).click();
          await platforms.getByRole('region', { name: renamed, exact: true }).getByRole('heading', { name: renamed, exact: true }).waitFor({ state: 'visible' });
          await platforms.getByRole('button', { name: messages.addControlSource, exact: true }).click();
          const addProduct = messages['setup.addProduct'].replace('{name}', source.productName);
          const menu = page.getByRole('menu', { name: messages.addControlSource, exact: true });
          await menu.getByRole('menuitem', { name: addProduct, exact: true }).click();
          const dialog = page.getByRole('dialog', { name: addProduct, exact: true });
          await dialog.waitFor({ state: 'visible' });
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
        }

        if (fixture.mcpHub === 'ready') {
          // Regression: opening the MCP hub clipped its workspace to the content height; the width toggle then changed its height.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const hub = page.getByRole('region', { name: messages['mcp.title'], exact: true });
          await hub.getByRole('searchbox').waitFor();
          const initial = await hub.boundingBox();
          await hub.getByRole('button', { name: messages.expandPanelWidth, exact: true }).click();
          const restore = hub.getByRole('button', { name: messages.restorePanelWidth, exact: true });
          await restore.waitFor();
          const expanded = await hub.boundingBox();
          if (!initial || !expanded || initial.height !== expanded.height) throw new Error('MCP hub changes height when expanded');
          await restore.click();
        }

        model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
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
        if (width >= 1280 && !fixture.page && !fixture.panel && fixture.detailTask === undefined && fixture.tasks.some(task => task.completed)) {
          // Regression: dragging a completed card left a click guard that swallowed its mark-read action.
          const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
          const completed = fixture.tasks.flatMap((task, index) => task.completed && model.topology.tasks.some(row => row.taskId === `fixture-task-${index}`)
            ? [{ task, id: `fixture-task-${index}` }] : []);
          const unread = [];
          for (const target of completed) {
            const group = page.getByRole('group', { name: target.task.title, exact: true });
            if (await group.getByRole('img', { name: messages['activity.unread'], exact: true }).isVisible()) unread.push(target);
          }
          if (!unread.length && completed.some(({ task, id }) => model.taskBubbles.some(bubble => bubble.agent === task.agent && bubble.id === id && bubble.unread))) {
            throw new Error('Expected unread completed tasks expose no unread bubbles');
          }
          for (const { task, id } of unread) {
            const title = task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const taskGroup = page.getByRole('group', { name: task.title, exact: true });
            const bubble = taskGroup.getByRole('button', { name: new RegExp(`^${title} ·`) });
            const bounds = await bubble.boundingBox();
            if (!bounds) throw new Error('Completed task is unavailable for mark-read acceptance');
            await bubble.dragTo(bubble, {
              sourcePosition: { x: bounds.width / 2, y: bounds.height / 2 },
              targetPosition: { x: bounds.width * 0.6, y: bounds.height * 0.6 },
            });
            if (!await taskGroup.isVisible()) throw new Error(`Dragged task left the visible queue: ${task.title}`);
            const markRead = taskGroup.getByRole('button', { name: messages['activity.markRead'], exact: true });
            await markRead.click();
            await page.waitForFunction(({ agent, id }) => window.__ARC_VIEW_MODEL__().taskBubbles.some(bubble => bubble.agent === agent && bubble.id === id && bubble.completed && !bubble.unread), { agent: task.agent, id });
            await bubble.getByRole('img', { name: messages['activity.unread'], exact: true }).waitFor({ state: 'hidden' });
            if (await page.getByRole('dialog').count()) throw new Error('Mark-read opened a task detail panel');
          }
        }
      } catch (error) { errors.push(String(error)); if (screenshots) await page.screenshot({ path: path.join(out, `${key}-error.png`), animations: 'disabled' }).catch(() => {}); }
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

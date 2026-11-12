import { runScenarioChecks, requiresBothThemes } from './families/index.mjs';
import { representedTopologyRoots } from './topology.mjs';
import { requireMainCheckout } from '../coding-lane.mjs';
if (!process.argv.includes('--lane-fixtures')) requireMainCheckout();
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
const requestedTheme = process.argv.find(arg => arg.startsWith('--theme='))?.slice('--theme='.length);
if (requestedTheme && !['light', 'dark', 'both'].includes(requestedTheme)) throw new Error('--theme must be light, dark or both');
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice('--port='.length) ?? 5187);
const setupOnly = process.argv.includes('--setup-only');
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
await mkdir(base, { recursive: true });
const previous = (await readdir(base)).filter(n => n.endsWith(`-${engine}`)).sort().at(-1);
const out = path.join(base, `${new Date().toISOString().replaceAll(':', '-')}-${engine}${screenshots ? '' : '-layout'}`);
await mkdir(out);
const scenarios = (await readdir(path.join(root, 'tooling/acceptance/scenarios'))).filter(f => f.endsWith('.json') && (!scenarioFilter || (scenarioFilter.endsWith('*') ? f.startsWith(scenarioFilter.slice(0, -1)) : f === `${scenarioFilter}.json`))).sort();
if (!scenarios.length) throw new Error('No matching acceptance scenario');
const report = { engine, screenshots, previous: screenshots ? previous ?? null : null, viewports: [{ width: 640, height: 800 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }], scenarios: [], failures: [] };
// This server has no production owner dependency: fixture API calls are intercepted
// in the dev-only module, and the browser rejects every real management request.
const server = await createServer({ mode: 'fixtures', cacheDir: path.join(root, 'node_modules/.vite-acceptance'), configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await ({ chromium, webkit }[engine]).launch();
  for (const file of scenarios) {
    const data = JSON.parse(await readFile(path.join(root, 'tooling/acceptance/scenarios', file), 'utf8'));
    const setup = !!(data.sourceSetup && data.sourceSetup.step !== 'welcome' || data.connectionSetup);
    if (setupOnly && !setup) continue;
    const themes = requestedTheme && requestedTheme !== 'both' ? [requestedTheme] : screenshots || requestedTheme === 'both' || requiresBothThemes(data) ? ['light', 'dark'] : [data.theme ?? 'light'];
    for (const [themeIndex, theme] of themes.entries()) {
    const fixture = { ...data, theme };
    for (const { width, height } of fixture.viewports ?? report.viewports) {
      const name = file.slice(0, -5), key = `${name}@${theme}-${width}x${height}`;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: fixture.historyDelayMs || fixture.slowDock ? 'no-preference' : 'reduce', locale: 'en-US',
        timezoneId: fixture.timezone ?? (name.startsWith('portrait-topology-') ? 'Asia/Shanghai' : undefined) });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', route => { errors.push(`Unexpected live API: ${route.request().url()}`); return route.abort(); });
      // Stable elapsed labels across runs, while rAF and the renderer keep working.
      await page.addInitScript(clock => { const original = Date; const fixed = original.parse(clock); Date = class extends original { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }; }, fixture.clock ?? '2026-01-01T00:00:00Z');
      const row = { name, theme, width, height, key, errors, baseline: screenshots ? 'missing' : 'disabled', changedPixels: null, changedRatio: null };
      const context={page,fixture,name,width,height,key,row,root,out,screenshots,errors,setup,behavior:themeIndex===0};
      try {
        await runScenarioChecks('beforeNavigate',context);
        await page.goto(`http://127.0.0.1:${port}/${fixture.browser ? 'browser.html' : ''}?scenario=${encodeURIComponent(name)}${fixture.browser ? '&key=arc_fixture_browser_key' : ''}&theme=${theme}`);
        await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, name, { timeout: 15000 });
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          const dialogs = [...document.querySelectorAll('.layer-dialog')].filter(node => getComputedStyle(node).visibility !== 'hidden');
          const panels = [...document.querySelectorAll('.layer-panel')].filter(node => !node.hasAttribute('data-exiting'));
          const expected = Math.max(0, dialogs.length - (panels.length ? 0 : 1));
          if (dialogs.length && document.querySelectorAll('.layer-scrim').length !== expected) throw new Error('Only nested dialogs may show a scrim.');
        });
        await runScenarioChecks("prepare",context);
        let model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
        if (!model.scenario?.ready) throw new Error(model.scenario?.error || 'Fixture task detail is not ready');
        if (!fixture.page && model.homepage?.mode !== 'tasks' && !model.topology) throw new Error('No rendered topology exported');
        const actualAgents = representedTopologyRoots(model.topology, 1);
        if (!fixture.page && model.homepage?.mode !== 'tasks' && fixture.agents.some(a => !actualAgents.includes(a))) throw new Error('Fixture agents were not rendered');
        const representedTasks = model.homepage?.tasks.length ?? model.topology?.tasks.reduce((sum, task) => sum + (task.count ?? 1), 0);
        if (!fixture.page && !fixture.panel && representedTasks !== fixture.tasks.length + (fixture.homepage?.remoteTaskCount ?? 0)) throw new Error(`Task count mismatch: ${representedTasks}/${fixture.tasks.length}`);
        if (fixture.panel?.kind === 'agent' && model.panels.agent?.agent !== fixture.panel.id) throw new Error('Agent panel not opened');
        if (fixture.panel?.kind === 'source' && model.panels.source !== fixture.panel.id) throw new Error('Source panel not opened');
        context.model=model;
        await runScenarioChecks("verify",context); model=context.model;

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
        context.model=model;
        await runScenarioChecks("afterCapture",context); model=context.model;
      } catch (error) { errors.push(error.stack ?? String(error)); if (screenshots) await page.screenshot({ path: path.join(out, `${key}-error.png`), animations: 'disabled' }).catch(() => {}); }
      if (errors.length) { report.failures.push(key); console.error(`${key}: ${errors.join("; ")}`); }
      report.scenarios.push(row);
      await page.close();
    }
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

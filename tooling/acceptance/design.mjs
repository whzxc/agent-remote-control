import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { startDesignServer } from '../design-server.mjs';

export async function acceptDesign() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = path.join(root, 'output/acceptance/design', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(out, { recursive: true });
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 5192);
  const server = await startDesignServer({ port });
  let browser;
  const report = { views: [], errors: [] };
  try {
    const response = await fetch(server.url);
    report.htmlBytes = Buffer.byteLength(await response.text());
    assert.ok(report.htmlBytes < 4096, 'The entry document embeds asset payloads again.');
    const manifest = await (await fetch(`${server.url}manifest`)).json();
    browser = await chromium.launch();
    for (const width of [640, 1280, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });
      page.on('pageerror', error => report.errors.push(error.message));
      const requests = [];
      page.on('request', request => { requests.push(request.url()); if (request.url().includes('/api/')) report.errors.push(`Unexpected live API: ${request.url()}`); });
      await page.goto(server.url);
      await page.getByRole('button', { name: 'View agent-panel', exact: true }).waitFor();
      await page.waitForFunction(() => [...document.images].length > 0 && [...document.images].every(image => image.complete && image.naturalWidth > 0));
      assert.equal(await page.getByRole('button', { name: /^View / }).count(), manifest.assets.length);
      assert.ok(!requests.some(url => url.includes('inline=1')), 'Overview requested full inline drawings.');
      assert.ok(!requests.some(url => url.includes('theme=dark')), 'Overview downloaded the inactive theme.');
      const overview = await page.evaluate(() => ({ elements: document.querySelectorAll('*').length, inline: document.querySelectorAll('.gallery-vector').length,
        resources: performance.getEntriesByType('resource').filter(item => item.initiatorType !== 'other').map(item => ({ url: new URL(item.name).pathname, bytes: item.encodedBodySize })) }));
      await page.screenshot({ path: path.join(out, `overview-${width}.png`) });
      await page.getByRole('button', { name: 'View agent-panel', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.gallery-vector svg').length > 0);
      const detail = await page.evaluate(() => ({ elements: document.querySelectorAll('*').length, inline: document.querySelectorAll('.gallery-vector').length }));
      assert.ok(detail.inline < manifest.assets.length, 'Detail mounted all drawings instead of the visible area.');
      const zoom = await page.getByLabel('Zoom', { exact: true }).textContent();
      const source = path.join(root, 'design/surfaces/agent-panel.svg');
      const before = await stat(source);
      const update = page.waitForResponse(response => response.url().includes('agent-panel.svg') && response.url().includes('inline=1'));
      try { await utimes(source, before.atime, new Date()); await update; }
      finally { await utimes(source, before.atime, before.mtime); }
      assert.equal(await page.getByLabel('Zoom', { exact: true }).textContent(), zoom, 'Asset refresh reset the camera.');
      // Narrow viewports render the shared single-choice control as a dropdown.
      const dark = page.getByRole('radio', { name: 'Dark', exact: true });
      if (await dark.count()) await dark.click();
      else { await page.getByRole('combobox', { name: 'Theme', exact: true }).click(); await page.getByRole('option', { name: 'Dark', exact: true }).click(); }
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelector('.gallery-vector svg[data-theme="dark"]'));
      await page.screenshot({ path: path.join(out, `detail-dark-${width}.png`) });
      await page.getByRole('button', { name: 'Fit all', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.gallery-vector').length === 0);
      assert.equal(await page.getByRole('alert').count(), 0);
      report.views.push({ width, overview, detail });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
  } finally {
    await browser?.close(); await server.close();
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`Design acceptance passed: ${out}`);
}

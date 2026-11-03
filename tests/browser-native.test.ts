import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeControl } from './helpers/native-control.ts';

test('browser ingress requires an independent key, exposes reads only, and revokes sessions on rotation', async () => {
  // Regression: public HTTPS ingresses had no authenticated read-only browser surface.
  const fixture = await nativeControl('');
  try {
    const ingress = await fixture.api('ingress', { id: 'browser', name: 'Browser fixture', controlSource: 'custom', transport: 'https', auth: 'bearer', bearerToken: 'fixture-mcp-token'.padEnd(40, 'x'), toolPolicy: 'all', config: { httpsProvider: 'custom', httpsUrl: 'https://browser.example/mcp' } });
    await fixture.api('ingress/browser/start', {});
    const base = `http://127.0.0.1:${ingress.config.httpsPort}`;
    const access = await fixture.api('browser/access');
    assert.match(access.key, /^arc_[a-f0-9]{64}$/);
    assert.equal((await fixture.api('browser/access')).key, access.key);
    assert.equal(JSON.parse((await fixture.shell('arc cli call browser.access')).stdout).result.key, access.key);
    assert.equal(access.links.find((row: any) => row.ingressId === 'browser').url, `https://browser.example/?key=${access.key}`);
    for (const route of ['/', '/view-api/status', '/assets/unknown.js']) {
      const denied = await fetch(base + route);
      assert.equal(denied.status, 401);
      assert.equal(await denied.text(), '');
    }
    const wrong = await fetch(`${base}/?key=wrong`);
    assert.equal(wrong.status, 401);
    assert.equal(await wrong.text(), '');
    const page = await fetch(`${base}/?key=${access.key}`);
    assert.equal(page.status, 200, 'Build the frontend before running browser native acceptance.');
    assert.match(page.headers.get('content-type')!, /text\/html/);
    const html = await page.text();
    assert.ok(!html.includes(access.key));
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    assert.match(page.headers.get('set-cookie')!, /Max-Age=31536000; Secure; HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie };
    const reopened = await fetch(base + '/', { headers });
    assert.equal(reopened.status, 200); await reopened.text();
    const stored = await fetch(base + '/view-api/status', { headers: { Authorization: `Bearer ${access.key}` } });
    assert.equal(stored.status, 200); await stored.text();
    const asset = html.match(/src="\.\/([^\"]+\.js)"/)![1];
    assert.equal((await fetch(`${base}/${asset}`, { headers })).status, 200);
    const status = await fetch(`${base}/view-api/status`, { headers });
    assert.equal(status.status, 200);
    assert.ok((await status.json() as any).core);
    // A valid browser credential must not authorize management writes or credentials.
    const deniedWrite = await fetch(`${base}/view-api/ingress/stop-all`, { method: 'POST', headers });
    assert.equal(deniedWrite.status, 403);
    assert.equal((await fixture.api('ingress')).find((row: any) => row.id === 'browser').running, true);
    assert.equal((await fetch(`${base}/view-api/config/credentials`, { headers })).status, 403);
    const controlWrite = await fetch(`${base}/view-api/tasks/control`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'codex_queue_control', args: { action: 'cancel' } }) });
    assert.equal(controlWrite.status, 403);
    const routingWrite = await fetch(`${base}/view-api/tasks/request-routing`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'handoff' }) });
    assert.equal(routingWrite.status, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${access.key}` } })).status, 401);
    const stream = await fetch(`${base}/view-api/events`, { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: snapshot/);
    const rotated = await fixture.api('browser/access/rotate', {});
    assert.notEqual(rotated.key, access.key);
    assert.equal((await fetch(`${base}/?key=${access.key}`)).status, 401);
    assert.equal((await fetch(`${base}/view-api/status`, { headers })).status, 401);
    while (!(await reader.read()).done) { /* Drain the last already-buffered snapshot. */ }
    const nextPage = await fetch(`${base}/?key=${rotated.key}`);
    assert.equal(nextPage.status, 200);
    await nextPage.text();
    await fixture.restart();
    assert.equal((await fixture.api('browser/access')).key, rotated.key);
  } finally { await fixture.close(); }
});

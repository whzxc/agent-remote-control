import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

test('browser task polling sends compact metadata once and no body for unchanged reads', async () => {
  // Regression: one open remote page uploaded 1.9 GB in ten minutes through repeated full snapshots and task inputs.
  const fixture = await nativeControl('');
  try {
    await fixture.restart(async directory => {
      await mkdir(path.join(directory, 'tasks'), { recursive: true });
      for (let i = 0; i < 32; i++) {
        const requestId = randomUUID();
        const threadId = randomUUID();
        await writeFile(path.join(directory, 'tasks', `${threadId}.json`), JSON.stringify({
          runtimeStatus: 'idle', title: `Task ${i}`, preview: 'p'.repeat(128 * 1024),
          configuration: { instructions: 'c'.repeat(64 * 1024) },
          ownership: { currentOwner: 'desktop', state: 'idle', history: [{ evidence: 'h'.repeat(64 * 1024) }] },
        }));
        await writeFile(path.join(directory, `${requestId}.json`), JSON.stringify({
          requestId, threadId, operation: 'create', state: 'completed',
          backendSession: 'previous-fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          task: { kind: 'create', title: `Task ${i}`, prompt: 'Task preview\n' + 'x'.repeat(64 * 1024), input: [{ type: 'image', imageUrl: 'data:image/png;base64,' + 'a'.repeat(128 * 1024) }], settings: {} },
          result: {}, approval: { decision: 'automatic', source: 'local' },
        }));
      }
    });
    const ingress = await fixture.api('ingress', { id: 'browser', name: 'Browser fixture', transport: 'https', controlSource: 'custom', auth: 'none', toolPolicy: 'all', config: { httpsProvider: 'custom', httpsUrl: 'https://browser.example/mcp' } });
    await fixture.api('ingress/browser/start', {});
    const { key } = await fixture.api('browser/access');
    const base = `http://127.0.0.1:${ingress.config.httpsPort}/view-api/`;
    const headers = { Authorization: `Bearer ${key}` };
    const first = await fetch(base + 'tasks', { headers });
    const text = await first.text(), data = JSON.parse(text);
    assert.equal(data.records.length, 32);
    assert.ok(Buffer.byteLength(text) < 128 * 1024, 'List metadata must not transfer prompts and attachments.');
    assert.ok(data.records.every((row: any) => row.task.prompt === 'Task preview' && row.task.promptTruncated));
    assert.ok(data.records.every((row: any) => row.runtime.runtimeStatus === 'idle' && row.runtime.ownership.currentOwner === 'desktop'));
    const etag = first.headers.get('etag')!;
    assert.ok(etag);
    let repeatedBytes = 0;
    for (let i = 0; i < 4; i++) {
      const next = await fetch(base + 'tasks', { headers: { ...headers, 'If-None-Match': i % 2 ? `W/${etag}` : etag } });
      assert.equal(next.status, 304);
      repeatedBytes += (await next.arrayBuffer()).byteLength;
    }
    assert.equal(repeatedBytes, 0);
    const changed = await fixture.api('preferences', { values: { 'arc.agent-order': '["codex"]' } }, 'PUT');
    assert.ok(changed);
    const status = await fetch(base + 'status', { headers });
    const snapshot = await status.json() as any;
    assert.ok(snapshot.core && Array.isArray(snapshot.sources));
    assert.equal(snapshot.logs, undefined);
    assert.equal(snapshot.core.logs, undefined);
    const stop = new AbortController();
    const stream = await fetch(base + 'events', { headers, signal: stop.signal });
    const reader = stream.body!.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /event: snapshot/);
    const observe = (async () => {
      let bytes = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; } }
      catch (error) { if (!stop.signal.aborted) throw error; }
      return bytes;
    })();
    await new Promise(resolve => setTimeout(resolve, 6500));
    stop.abort();
    assert.ok(await observe < 128 * 1024, 'Idle streams must not resend a full diagnostic snapshot every two seconds.');
  } finally { await fixture.close(); }
});

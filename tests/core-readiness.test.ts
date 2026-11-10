import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCore, coreRequest } from '../tooling/dev-core.mjs';

test('Core readiness remains usable while an owner projection is rebuilding', async () => {
  // Regression: retained-state migration exhausted the development readiness deadline before Core could serve clients.
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-ready-'));
  const identity = { pid: process.pid, instance: 'fixture-core', owner: 'core' };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/healthz') response.end(JSON.stringify(identity));
    else { response.statusCode = 503; response.end(JSON.stringify({ error: 'INDEX_NOT_READY' })); }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const endpoint = { ...identity, port: (server.address() as any).port, token: 'fixture-token' };
    await mkdir(path.join(directory, 'app'));
    await writeFile(path.join(directory, 'app/native.json'), JSON.stringify(endpoint));
    await assert.rejects(coreRequest(endpoint, 'tasks'), /INDEX_NOT_READY/);
    assert.deepEqual(await readCore(directory), endpoint);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { stopCore } from '../tooling/dev-core.mjs';

test('isolated owner can stop Core after Desktop disappears during quit', async () => {
  // Regression: supervisor stayed alive with its port after Desktop exited and Core refused the CLI shutdown lease.
  const endpoint = { instance: 'isolated-instance', pid: 0, port: 12345, token: 'endpoint-token' };
  const owner = { ...endpoint, id: 'private-startup-identity' };
  let desktop = true;
  let stopped = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const route = new URL(String(input)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (route === '/api/runtime/clients') return Response.json(desktop ? [{ kind: 'desktop' }] : []);
    if (route === '/api/app/quit') {
      desktop = false;
      return Response.json({ error: 'Desktop is not running' }, { status: 400 });
    }
    if (route === '/api/runtime/lease') {
      assert.notEqual(body.id, owner.id);
      return Response.json({});
    }
    if (route === '/api/runtime/shutdown') {
      assert.equal(body.id, owner.id);
      stopped = true;
      return Response.json({ closing: true });
    }
    throw new Error(`Unexpected request ${route}`);
  };
  try {
    await assert.rejects(stopCore(endpoint, { ...owner, instance: 'replacement' }), /ownership changed/);
    await stopCore(endpoint, owner);
    assert.equal(stopped, true);
  } finally { globalThis.fetch = original; }
});

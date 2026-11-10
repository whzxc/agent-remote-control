import test from 'node:test';
import assert from 'node:assert/strict';
import { stopCore } from '../tooling/dev-core.mjs';

test('isolated owner can stop restarted Core after Desktop disappears during quit', async () => {
  // Regression: supervisor shutdown rejected a restarted isolated Core because its PID and token changed.
  const initial = { instance: 'core-before-restart', pid: 123, port: 12344, token: 'old-token' };
  const endpoint = { ...initial, instance: 'core-after-restart', pid: 0, port: 12345, token: 'new-token' };
  const owner = { instance: 'isolated-instance', id: 'private-startup-identity' };
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
      if (body.isolatedOwner?.instance !== owner.instance || body.isolatedOwner?.id !== owner.id) {
        return Response.json({ error: 'Core ownership changed. No Core was stopped.' }, { status: 403 });
      }
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
    assert.equal(desktop, true);
    assert.equal(stopped, false);
    await assert.rejects(stopCore(endpoint, { ...owner, id: 'another-supervisor' }), /ownership changed/);
    assert.equal(desktop, true);
    await stopCore(endpoint, owner);
    assert.equal(stopped, true);
  } finally { globalThis.fetch = original; }
});

test('isolated owner cannot quit the installed Core', async () => {
  // Regression: following isolated Core restarts must not grant shutdown authority over installed Core.
  const endpoint = { instance: 'installed-core', pid: 0, port: 12345, token: 'installed-token' };
  let desktop = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === '/api/runtime/clients') return Response.json([{ kind: 'desktop' }]);
    if (route === '/api/runtime/lease') return Response.json({ error: 'Core ownership changed. No Core was stopped.' }, { status: 403 });
    if (route === '/api/app/quit' || route === '/api/runtime/shutdown') desktop = false;
    return Response.json({});
  };
  try {
    await assert.rejects(stopCore(endpoint, { instance: 'isolated-instance', id: 'private-startup-identity' }), /ownership changed/);
    assert.equal(desktop, true);
  } finally { globalThis.fetch = original; }
});

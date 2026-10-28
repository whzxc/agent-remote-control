import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';

async function eventually(ready: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ready());
}

async function harness(run: (server: Awaited<ReturnType<typeof createServer>>, window: Window) => Promise<void>) {
  const window = new Window({ url: 'http://localhost' });
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  try { await run(server, window); }
  finally { globalThis.fetch = originalFetch; await server.close(); await window.happyDOM.close(); }
}

test('Agent order survives refresh and disable-enable transitions', async () => {
  // Regression: fd4498c4 refreshed or disabled Agents lost their manual order.
  await harness(async server => {
    const saved: Record<string, string> = {};
    const rows = ['codex', 'claude', 'pi'].map(agent => ({ agent, installed: true, enabled: true }));
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/preferences' && init?.method === 'PUT') Object.assign(saved, JSON.parse(String(init.body)).values);
      if (String(url) === '/api/agents' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        Object.assign(rows.find(row => row.agent === body.agent)!, { enabled: body.enabled });
        return new Response(JSON.stringify({ enabled: body.enabled }));
      }
      return new Response(JSON.stringify({ agents: structuredClone(rows) }));
    };
    const state = await server.ssrLoadModule('/ui/state/agents.ts');
    await state.refreshAgents();
    state.reorderAgents(['pi', 'claude', 'codex']);
    const order = () => state.orderedAgents().map((row: { agent: string }) => row.agent);
    await state.toggleAgent(rows[2], false);
    await state.refreshAgents();
    assert.deepEqual(order(), ['pi', 'claude', 'codex']);
    await state.toggleAgent(rows[2], true);
    assert.deepEqual(order(), ['pi', 'claude', 'codex']);
    await eventually(() => saved['arc.agent-order'] === JSON.stringify(order()));
  });
});

test('an incoming preference event cannot overwrite the current remote preference', async () => {
  // Regression: fd4498c4 replayed incoming storage events as writes and reverted newer preferences.
  await harness(async (server, window) => {
    const key = 'fixture.preference', remote = { [key]: 'current' };
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/preferences' && init?.method === 'PUT') Object.assign(remote, JSON.parse(String(init.body)).values);
      return new Response('{}');
    };
    const { preference } = await server.ssrLoadModule('/ui/state/store.ts');
    window.localStorage.setItem(key, 'current');
    const value = preference(key, '', (raw: string) => raw, (raw: string) => raw);
    window.dispatchEvent(new window.StorageEvent('storage', { key, oldValue: 'initial', newValue: 'stale' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(value.get(), 'stale');
    assert.equal(remote[key], 'current');
    assert.equal(window.localStorage.getItem(key), 'current');
    value.set('local-choice');
    await eventually(() => remote[key] === 'local-choice');
    assert.equal(remote[key], 'local-choice');
  });
});

import test, { before, after } from 'node:test';
import { createServer } from 'vite';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import type { ProviderSnapshot } from '../ui/subscriptions/types.ts';
let presentSubscription: typeof import('../ui/subscriptions/response.ts').presentSubscription;
let server: Awaited<ReturnType<typeof createServer>>;
const window = new Window({ url: 'http://localhost' });
before(async () => {
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
  server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  ({ presentSubscription } = await server.ssrLoadModule('/ui/subscriptions/response.ts'));
});
after(async () => { await server?.close(); await window.happyDOM.close(); });

const provider: ProviderSnapshot = { providerId: 'cursor', agentId: 'cursor', agentIds: ['cursor'], name: 'Cursor',
  eligible: true, state: 'ready', refreshing: false, blockedPoolIds: [], hasCredential: true, acceptsKey: false,
  windows: [{ id: 'plan', poolId: 'plan', label: 'plan', usedPercent: 4 },
    { id: 'cursorModels', poolId: 'cursorModels', label: 'cursorModels', usedPercent: 4 }] };

test('non-weekly subscriptions retain a usable display window', () => {
  // Regression: Cursor had monthly quota data but the weekly-only presentation selector removed its display window.
  assert.equal(presentSubscription(provider).displayWindowId, provider.windows[0].id);
  assert.equal(presentSubscription({ ...provider, displayWindowId: 'cursorModels' }).displayWindowId, 'cursorModels');
  assert.equal(presentSubscription({ ...provider, displayWindowId: 'retired' }).displayWindowId, provider.windows[0].id);
  assert.equal(presentSubscription({ ...provider, windows: [] }).displayWindowId, undefined);
  assert.equal(presentSubscription({ ...provider, windows: [{ ...provider.windows[0], usedPercent: NaN }, provider.windows[1]] }).displayWindowId, provider.windows[1].id);
});
test('weekly preference and Codex reserve filtering remain intact', () => {
  // Regression: monthly fallback must preserve weekly preference and never reintroduce hidden Codex reserve quota.
  const weekly = { id: 'weekly', poolId: 'main', label: 'weekly', usedPercent: 20 };
  assert.equal(presentSubscription({ ...provider, windows: [...provider.windows, weekly] }).displayWindowId, weekly.id);
  const reserve = { ...provider.windows[0], poolId: 'base_model_inference' };
  assert.equal(presentSubscription({ ...provider, agentId: 'codex', windows: [reserve] }).displayWindowId, undefined);
});

import test, { before, after } from 'node:test';
import { createServer } from 'vite';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import type { ProviderSnapshot } from '../ui/subscriptions/types.ts';
let presentSubscription: typeof import('../ui/subscriptions/response.ts').presentSubscription;
let groupQuotaState: typeof import('../ui/components/ui/TopologyGroup.tsx').groupQuotaState;
let server: Awaited<ReturnType<typeof createServer>>;
const window = new Window({ url: 'http://localhost' });
before(async () => {
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
  server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  ({ groupQuotaState } = await server.ssrLoadModule('/ui/components/ui/TopologyGroup.tsx'));
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

test('capsule quota states reflect availability and exhaustion before usage or timing warnings', () => {
  // Property: capsule quota states distinguish unavailable, healthy, low and exhausted readings without following the decorative accent.
  const now = Date.parse('2026-01-01T00:00:00Z');
  const current = (usedPercent: number): ProviderSnapshot => ({ ...provider, windows: [{ ...provider.windows[0], usedPercent }] });
  for (const used of [0, 25, 49]) assert.equal(groupQuotaState(current(used), now), 'ok');
  for (const used of [50, 80, 99]) assert.equal(groupQuotaState(current(used), now), 'low');
  const timed = { ...current(80), windows: [{ ...current(80).windows[0], label: 'weekly', resetsAt: new Date(now + 6 * 86400000).toISOString() }] };
  assert.equal(groupQuotaState(timed, now), 'low');
  assert.equal(groupQuotaState(current(100), now), 'out');
  assert.equal(groupQuotaState({ ...current(0), accountBlocked: true }, now), 'out');
  assert.equal(groupQuotaState({ ...current(0), state: 'stale' }, now), 'unknown');
  assert.equal(groupQuotaState({ ...provider, windows: [] }, now), 'unknown');
});

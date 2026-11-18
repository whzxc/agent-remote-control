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

;
;

test('Core restart gaps preserve the last complete subscription snapshot', async () => {
  // Recurring bug class: persistence: subscription snapshot survives Core restart
  const { acceptSubscriptions, subscriptions } = await server.ssrLoadModule('/ui/state/subscriptions.ts');
  acceptSubscriptions(undefined);
  acceptSubscriptions({});
  assert.equal(subscriptions.get().snapshot, undefined);
  const snapshot = { instanceId: 'before-restart', revision: 2, settings: { enabled: true, refreshMinutes: 5, agentProviders: {} }, providers: [provider] };
  acceptSubscriptions(snapshot);
  const previous = subscriptions.get().snapshot;
  for (const next of [undefined, null, {}, { instanceId: 'restarting', revision: 1 }, { ...snapshot, providers: undefined }]) {
    acceptSubscriptions(next);
    assert.equal(subscriptions.get().snapshot, previous);
  }
  acceptSubscriptions({ ...snapshot, instanceId: 'after-restart', revision: 1 });
  assert.equal(subscriptions.get().snapshot.instanceId, 'after-restart');
  acceptSubscriptions(snapshot);
  assert.equal(subscriptions.get().snapshot.instanceId, 'after-restart');
});

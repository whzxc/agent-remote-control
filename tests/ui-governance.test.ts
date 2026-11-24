import test, { after, before } from 'node:test';
import { createServer } from 'vite';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { layerFrame } from '../ui/components/ui/layerFrame.ts';
import { layerInsetToken } from '../ui/components/ui/layerTokens.ts';
import { homepageTaskFamilies, type TrackedActivity } from '../ui/state/activityModel.ts';
import type { ProviderSnapshot, Snapshot } from '../ui/subscriptions/types.ts';
import type { AgentActivitySession, AgentConversation, ProviderAccount } from '../ui/types.ts';

let server: Awaited<ReturnType<typeof createServer>>;
let quota: typeof import('../ui/state/quota.ts');
let lineage: typeof import('../ui/state/taskLineage.ts');
let homepage: typeof import('../ui/state/homepageTasks.ts');
const browser = new Window({ url: 'http://localhost' });

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, localStorage: browser.localStorage });
  server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  quota = await server.ssrLoadModule('/ui/state/quota.ts');
  lineage = await server.ssrLoadModule('/ui/state/taskLineage.ts');
  homepage = await server.ssrLoadModule('/ui/state/homepageTasks.ts');
});

after(async () => {
  await server?.close();
  await browser.happyDOM.close();
});

test('layer geometry applies the same selected inset above and below capped content', () => {
  // Algorithmic core: the layer solver centers both measured and capped content within the viewport.
  const values = { '--layer-panel-inset': 76, '--layer-top-desktop': 48, '--layer-top-browser': 20 };
  const cases = [
    ['panel', true, '--layer-panel-inset'], ['panel', false, '--layer-panel-inset'],
    ['dialog', true, '--layer-top-desktop'], ['dialog', false, '--layer-top-browser'],
  ] as const;
  for (const [kind, desktop, expected] of cases) {
    assert.equal(layerInsetToken(kind, desktop), expected);
    const viewport = { width: 1280, height: 800, desktop };
    const tokens = { sizes: { m: 560, xl: 960 }, margin: 16,
      desktopInset: values[layerInsetToken(kind, true)], browserInset: values[layerInsetToken(kind, false)] };
    const capped = layerFrame('m', viewport, tokens, 1000);
    assert.equal(capped.y, values[expected]);
    assert.equal(viewport.height - capped.y - capped.height, capped.y);
    const natural = layerFrame('m', viewport, tokens, 213);
    assert.equal(natural.height, 213);
    assert.equal(viewport.height - natural.y - natural.height, natural.y);
  }
});

const window = { id: 'week', poolId: 'subscription', label: 'weekly', usedPercent: 22 };
const account: ProviderAccount = {
  id: 'account-1', provider: 'anthropic', identityKey: 'fixture', alias: 'Team', createdAt: '', observedAt: '',
  health: { state: 'ready' }, sources: ['source-1'], notifications: { state: 'n/a', sessions: [] },
  agentProfiles: [{ agent: 'claude', profileId: 'profile', kind: 'cli-profile', default: true, state: 'signed-in' }],
  quota: { state: 'ready', windows: [window] },
};
const provider: ProviderSnapshot = {
  providerId: 'claude-code', agentId: 'claude', agentIds: ['claude'], name: 'Claude', eligible: true,
  state: 'stale', observedAt: '2020-01-01T00:00:00Z', error: { code: 'no-limits-reported' }, windows: [{ ...window, usedPercent: 90 }],
  refreshing: false, blockedPoolIds: [], hasCredential: true, acceptsKey: false,
};
const snapshot = (reading: ProviderSnapshot): Snapshot => ({
  instanceId: 'fixture', revision: 1, settings: { enabled: true, refreshMinutes: 5, agentProviders: {} }, providers: [reading],
});

test('an expired platform reading falls back to the default signed-in quota', () => {
  // Algorithmic core: Agent and source quota projections reuse the signed-in account when a platform reading expires.
  const alternate: ProviderAccount = { ...account, id: 'account-2', sources: [],
    agentProfiles: account.agentProfiles.map(profile => ({ ...profile, default: false })), quota: { state: 'ready', windows: [{ ...window, usedPercent: 51 }] } };
  const readings = [alternate, account];
  assert.deepEqual(quota.resolveAgentQuota('claude', snapshot(provider), readings)?.windows, [window]);
  assert.deepEqual(quota.resolveAgentQuota('claude', undefined, readings)?.windows, [window]);
  assert.deepEqual(quota.resolveSourceQuota('source-1', snapshot(provider), readings)?.windows, [window]);
  assert.equal(quota.resolveAgentQuota('claude', snapshot(provider), [alternate, { ...alternate, id: 'account-3' }]), provider);
});

test('fresh platform quota is retained and linked sources can use shared subscriptions', () => {
  // Algorithmic core: source quota follows explicit subscription linkage or a unique signed-in Agent account.
  const ready = { ...provider, state: 'ready', error: undefined };
  const missing = { ...account, quota: { state: 'unavailable', windows: [] } };
  const fresh = { ...provider, observedAt: new Date().toISOString() };
  assert.equal(quota.resolveAgentQuota('claude', snapshot(ready), [account]), ready);
  assert.equal(quota.resolveAgentQuota('claude', snapshot(fresh), [account]), fresh);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [missing]), ready);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [{ ...missing, quotaProviderId: ready.providerId, agentProfiles: [] }]), ready);
  const sole = { ...missing, provider: ready.providerId, agentProfiles: [] };
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [sole]), ready);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [sole, { ...sole, id: 'other-account', sources: [] }]), undefined);
  assert.equal(quota.resolveSourceQuota('other-source', snapshot(ready), [account]), undefined);
});

const session: AgentActivitySession = {
  id: 'a', source: 'codex-thread', phase: 'idle', phaseSince: null, headline: '', timeline: true,
};

test('local CLI caller marks identify the Agent that dispatched the task', () => {
  // Contract: recorded dispatch provenance provides a display caller within the local CLI ingress.
  const controlSource = { kind: 'local-cli', id: 'local' };
  const caller = { agent: 'antigravity', conversationId: 'dispatch-origin' };
  const chain = (dispatchSummary: AgentActivitySession['dispatchSummary']) =>
    lineage.resolveTaskOriginChain({ agent: 'codex', session: { ...session, dispatchSummary } });
  assert.deepEqual(chain({ controlSource, caller }).map(mark => [mark.kind, mark.label]),
    [['agent', 'Antigravity'], ['agent', 'Codex']]);
  const [plain] = chain({ controlSource });
  assert.ok(plain?.kind === 'source' && plain.platform === 'local-cli');
  assert.equal(chain({ controlSource: { kind: 'custom', id: 'external' }, caller })[0]?.kind, 'source');
});

test('conversation rows with the same ID retain distinct Agent ownership and native families', () => {
  // Contract: the unified conversation page keys native records and their parent references by Agent.
  const row = (id: string, fields: Partial<AgentConversation> = {}): AgentConversation =>
    ({ id, source: 'native', createdAt: '2026-01-01T00:00:00Z', ...fields });
  const combined: Record<string, Map<string, TrackedActivity>> = {};
  const updates = new Map<string, string>();
  homepage.mergeHomepageConversations(combined, updates, [
    row('shared', { agent: 'antigravity', title: 'Parent', updatedAt: '2026-01-02T00:00:00Z' }),
    row('child', { agent: 'antigravity', parentSessionId: 'shared', relationKind: 'subagent' }),
    row('shared', { source: 'codex-thread', title: 'Codex conversation', updatedAt: '2026-01-03T00:00:00Z' }),
    row('cli', { agent: 'pi', title: 'Pi conversation' }),
  ]);
  const tasks = Object.entries(combined).flatMap(([agent, sessions]) => [...sessions.values()].map(session => ({
    key: JSON.stringify([agent, session.id]), agent, session, group: 'recent' as const,
    activity: { snapshot: [], steps: [] }, sourceIds: [],
  })));
  const families = homepageTaskFamilies(tasks);
  assert.deepEqual(new Set(families.map(family => family.parent.agent)), new Set(['codex', 'antigravity', 'pi']));
  assert.equal(families.find(family => family.parent.agent === 'antigravity')?.children[0]?.session.id, 'child');
  assert.equal(families.find(family => family.parent.agent === 'codex')?.parent.session.title, 'Codex conversation');
  assert.equal(updates.get(JSON.stringify(['antigravity', 'shared'])), '2026-01-02T00:00:00Z');
});

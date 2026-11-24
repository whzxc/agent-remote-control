import test, { after, before } from 'node:test';
import { createServer } from 'vite';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { act, createElement as h, useRef } from 'react';
import { fireEvent, within } from '@testing-library/dom';
import { arcActionPositions, hubControlGeometry, hubHoverRegion } from '../ui/topology/geometry.ts';
import { layerFrame } from '../ui/components/ui/layerFrame.ts';
import { layerInsetToken } from '../ui/components/ui/layerTokens.ts';
import { homepageTaskFamilies, type TrackedActivity } from '../ui/state/activityModel.ts';
import type { ProviderSnapshot, Snapshot } from '../ui/subscriptions/types.ts';
import type { TaskSnapshotRow } from '../ui/state/taskProjection.ts';
import type { AgentActivitySession, AgentConversation, ProviderAccount } from '../ui/types.ts';

let server: Awaited<ReturnType<typeof createServer>>;
let taskCard: typeof import('../ui/components/ui/TaskCard.tsx');
let previews: typeof import('../ui/state/taskExecution.ts');
let quota: typeof import('../ui/state/quota.ts');
let lineage: typeof import('../ui/state/taskLineage.ts');
let homepage: typeof import('../ui/state/homepageTasks.ts');
const browser = new Window({ url: 'http://localhost' });

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, localStorage: browser.localStorage });
  server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  quota = await server.ssrLoadModule('/ui/state/quota.ts');
  lineage = await server.ssrLoadModule('/ui/state/taskLineage.ts');
  taskCard = await server.ssrLoadModule('/ui/components/ui/TaskCard.tsx');
  previews = await server.ssrLoadModule('/ui/state/taskExecution.ts');
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

test('ready quota outranks stale quota and linked sources can use shared subscriptions', () => {
  // Algorithmic core: source quota follows explicit subscription linkage or a unique signed-in Agent account.
  const ready = { ...provider, state: 'ready', error: undefined };
  const missing = { ...account, quota: { state: 'unavailable', windows: [] } };
  const fresh = { ...provider, observedAt: new Date().toISOString() };
  assert.equal(quota.resolveAgentQuota('claude', snapshot(ready), [account]), ready);
  assert.deepEqual(quota.resolveAgentQuota('claude', snapshot(fresh), [account])?.windows, [window]);
  assert.equal(quota.resolveAgentQuota('claude', snapshot(fresh), [missing]), fresh);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [missing]), ready);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [{ ...missing, quotaProviderId: ready.providerId, agentProfiles: [] }]), ready);
  const unlinked = { ...missing, provider: ready.providerId, agentProfiles: [] };
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [unlinked]), undefined);
  assert.equal(quota.resolveSourceQuota('source-1', snapshot(ready), [missing, { ...missing, id: 'other-account', sources: [] }]), undefined);
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
  assert.ok(chain({ controlSource, caller }).every(mark => mark.caption === undefined));
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

test('preview retry classifies local Core transport errors only', () => {
  // Contract: local Core transport failures retry while deterministic timeline failures are actionable immediately.
  for (const error of [
    'DESKTOP_BUSY', 'FRONT_DOOR_BUSY', 'FRONT_DOOR_UNAVAILABLE', 'FRONT_DOOR_CORE_LOST',
    'CORE_UNAVAILABLE', 'Cannot connect to local Core', 'Core is not ready', 'core shutting down',
    'Failed to fetch', 'Load failed', 'timeout',
  ]) assert.equal(previews.isTransientPreviewError(new Error(error)), true, error);
  assert.equal(previews.isTransientPreviewError({ code: 'DESKTOP_BUSY', message: 'Wait briefly.' }), true);
  for (const error of [
    'SCENARIO_PREVIEW_READ_FAILED', 'SCENARIO_TIMELINE_UNAVAILABLE', 'INVALID_SESSION_ID: timeout',
    'Database is locked', 'UNRELATED_TIMEOUT', undefined,
  ]) assert.equal(previews.isTransientPreviewError(error), false, String(error));
});

test('preview reads admit four cards at a time and back off without blocking explicit reads', async context => {
  // Recurring bug class: concurrency keeps background transport admission bounded while explicit recovery remains responsive.
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('main');
  document.body.append(mount);
  const root = createRoot(mount);
  const inFlight = new Map<string, (response: Response) => void>();
  const fetch = globalThis.fetch;
  const intersectionObserver = globalThis.IntersectionObserver;
  const actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class {
      callback: (entries: { isIntersecting: boolean }[]) => void;
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = callback; }
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() {}
    },
    fetch: async (_url: string, request: RequestInit) => {
      const { id } = JSON.parse(String(request.body)) as { id: string };
      return new Promise<Response>(resolve => inFlight.set(id, resolve));
    },
  });
  const finish = async (id: string, error?: string) => {
    const resolve = inFlight.get(id);
    assert.ok(resolve, id);
    inFlight.delete(id);
    await act(async () => resolve(Response.json(error ? { error } : { status: 'completed', entries: [] }, { status: error ? 503 : 200 })));
  };
  const screen = within(mount);
  function Preview({ id }: { id: string }) {
    const card = useRef<HTMLElement>(null);
    const { failed, retry } = previews.useTaskPreview('codex', id, true, card, true);
    return h('article', { ref: card }, h('output', { 'aria-label': id }, failed ? 'Failed' : 'Available'),
      h('button', { onClick: retry }, `Retry ${id}`));
  }
  try {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => root.render(Array.from({ length: 11 }, (_, index) => h(Preview, { key: index, id: `card-${index}` }))));
    assert.deepEqual([...inFlight.keys()], ['card-0', 'card-1', 'card-2', 'card-3']);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry card-10' })));
    assert.ok(inFlight.has('card-10'));
    const detail = previews.refreshTaskExecution('codex', 'detail');
    assert.ok(inFlight.has('detail'));
    await finish('card-10');
    await finish('detail');
    await detail;

    await finish('card-0', 'SCENARIO_PREVIEW_READ_FAILED');
    assert.equal(screen.getByRole('status', { name: 'card-0' }).textContent, 'Failed');
    assert.ok(inFlight.has('card-4'));
    await finish('card-1', 'FRONT_DOOR_BUSY');
    assert.equal(screen.getByRole('status', { name: 'card-1' }).textContent, 'Available');
    assert.ok(inFlight.has('card-5'));
    // Drain the older work so the clock alone determines retry admission.
    for (let i = 2; i < 10; i++) await finish(`card-${i}`);
    assert.deepEqual([...inFlight.keys()], []);
    await act(async () => context.mock.timers.tick(399));
    assert.equal(inFlight.has('card-1'), false);
    await act(async () => context.mock.timers.tick(1));
    await finish('card-1', 'FRONT_DOOR_UNAVAILABLE');
    assert.equal(screen.getByRole('status', { name: 'card-1' }).textContent, 'Available');
    await act(async () => context.mock.timers.tick(1199));
    assert.equal(inFlight.has('card-1'), false);
    await act(async () => context.mock.timers.tick(1));
    await finish('card-1', 'Failed to fetch');
    assert.equal(screen.getByRole('status', { name: 'card-1' }).textContent, 'Failed');
    await act(async () => context.mock.timers.tick(1200));
    assert.equal(inFlight.has('card-1'), false);

    const recovery = previews.refreshTaskExecution('codex', 'card-1');
    await finish('card-1');
    await recovery;
    assert.equal(screen.getByRole('status', { name: 'card-1' }).textContent, 'Available');
  } finally {
    await act(async () => root.unmount());
    previews.resetTaskExecutions();
    context.mock.timers.reset();
    Object.assign(globalThis, { fetch, IntersectionObserver: intersectionObserver, IS_REACT_ACT_ENVIRONMENT: actEnvironment });
    mount.remove();
  }
});

test('preview selection preserves anchors and fills spare slots in chronological order', () => {
  // Algorithmic core: the preview budget retains the latest semantic anchors and takes the newest remaining group.
  const group = (role: TaskSnapshotRow['role'], extra?: Partial<TaskSnapshotRow>): TaskSnapshotRow[] =>
    [{ role, id: role, text: role, turnId: 'turn', status: 'completed', ...extra }];
  const sparse = [group('agent', { final: true }), group('source'), group('agent'), group('source'), group('agent')];
  assert.deepEqual(taskCard.selectSnapshotGroupIndices(sparse, 4), [0, 2, 3, 4]);
  const mixed = [...sparse, group('step', { kind: 'thinking' }), group('step', { kind: 'command', tool: {
    id: 'command', turnId: 'turn', type: 'command', status: 'completed', startedAt: null, updatedAt: '', cursor: 1,
  } }), group('agent')];
  assert.deepEqual(taskCard.selectSnapshotGroupIndices(mixed, 4), [0, 3, 5, 6]);
  assert.deepEqual(taskCard.selectSnapshotGroupIndices(mixed, 3), [0, 3, 6]);
});

test('task card time prefers elapsed duration and falls back to the recorded local clock', () => {
  // Contract: task timestamps expose elapsed duration or the chosen recorded wall time and its ISO timestamp.
  const endedAt = new Date(2026, 2, 15, 0, 7, 30);
  const task = { key: 'card', agent: 'codex', group: 'recent' as const, endedAt: endedAt.toISOString(),
    session: { ...session, orderAt: endedAt.getTime() + 3600000, turnDurationMs: 142000 } };
  assert.equal(taskCard.formatTaskCardTime(task, 0, 'en')?.label, '02:22');
  assert.equal(taskCard.formatTaskCardTime(task, 0, 'en', 0)?.dateTime, 'PT0S');
  const wallTime = taskCard.formatTaskCardTime({ ...task, session: { ...task.session, turnDurationMs: null } }, 0, 'en');
  assert.equal(wallTime?.label, '00:07');
  assert.equal(wallTime?.dateTime, endedAt.toISOString());
  assert.ok(wallTime?.title?.includes('2026'));
});

test('one hub hover region encloses opposing popups and both wing control pairs', () => {
  // Algorithmic core: landscape and portrait hover bounds preserve a continuous padded path between center controls.
  const hub = { x: 300, y: 240, Re: 65 };
  const portrait = { earOffset: 65, earHalf: 42 };
  for (const frame of [undefined, portrait]) {
    const region = hubHoverRegion(hub, frame);
    const within = (x: number, y: number, pad: number) => {
      assert.ok(x - pad >= region.x && x + pad <= region.x + region.width);
      assert.ok(y - pad >= region.y && y + pad <= region.y + region.height);
    };
    for (const side of [-1, 1] as const) {
      const { powerBottom } = hubControlGeometry(hub.Re);
      within(hub.x, hub.y + side * powerBottom, 16);
      within(hub.x + side * powerBottom, hub.y, 16);
      const buttons = arcActionPositions(frame ? { kind: 'line',
        start: { x: hub.x + side * frame.earOffset, y: hub.y },
        end: { x: hub.x + side * (frame.earOffset + frame.earHalf), y: hub.y }, outward: { x: 0, y: side } }
        : { kind: 'arc', ...hub, radius: hub.Re, lo: -25, hi: 25, side }, 2);
      for (const { x, y, dx, dy } of buttons) within(x + dx, y + dy, 15 + 16);
    }
  }
});

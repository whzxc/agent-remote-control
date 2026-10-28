import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

async function harness() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  const window = new Window({ url: 'http://localhost' });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0, time = 0;
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    Node: window.Node, NodeFilter: window.NodeFilter, NodeList: window.NodeList, HTMLCollection: window.HTMLCollection, SVGElement: window.SVGElement, DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver, CustomEvent: window.CustomEvent, Event: window.Event,
    DOMRect: window.DOMRect, CSS: window.CSS, localStorage: window.localStorage,
    ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id) });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1280 }, clientHeight: { configurable: true, get: () => 800 },
  });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('main'); document.body.append(mount);
  const root = createRoot(mount), page = within(mount);
  const advance = async () => act(() => {
    time += 1000 / 60;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
  });
  const settle = async () => {
    for (let i = 0; i < 300 && frames.size; i++) await advance();
    assert.equal(frames.size, 0, 'Topology must stop scheduling frames after settling');
  };
  return { server, root, mount, page, frames, advance, settle,
    async close() { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); globalThis.fetch = originalFetch; } };
}

test('topology account source keeps its platform name in both modes', async () => {
  // Regression: single-account Tree nodes displayed a source alias instead of their platform name.
  const fixture = await harness();
  try {
    const { server, root, page } = fixture;
    const { default: Overview } = await server.ssrLoadModule('/ui/components/ConnectionOverview.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { agents } = await server.ssrLoadModule('/ui/state/agents.ts');
    const { topologyMode } = await server.ssrLoadModule('/ui/topology/accountState.ts');
    const { controlSource } = await server.ssrLoadModule('/ui/controlSources.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const source = { id: 'source-one', ingressId: 'ingress-one', credential: { type: 'oauth-grant', grantId: 'example-grant', clientId: 'example-client' }, product: 'chatgpt', platform: 'openai', label: 'Personal fixture', state: 'connected' };
    const local = { ...source, id: 'example-local', ingressId: 'local-cli', credential: { type: 'local' }, product: 'local-cli', platform: 'local', label: 'Local fixture' };
    const ingress = { id: source.ingressId, sources: [source], name: 'Fixture ingress', controlSource: source.product,
      enabled: true, running: true, state: 'ready', auth: 'oauth', transport: 'https', error: '', config: { configured: true } };
    const status = { ingresses: [ingress], core: { backendSession: 'fixture', appServer: { state: 'ready' } }, platform: 'darwin', logs: [] };
    connector.set({ status, sources: [source, local], sourcesLoaded: true, loading: false, busy: '', error: '', feedback: { text: '', error: false } });
    agents.set({ items: [], loading: false, error: '' });
    const account = { id: 'account-one', alias: 'Personal', provider: 'openai', identityKey: 'openai:fixture', sources: [source.id], agentProfiles: [],
      notifications: { state: 'mcp-events', sessions: [] }, quota: { state: 'unavailable', windows: [] } };
    globalThis.fetch = async input => {
      const path = String(input);
      return new Response(JSON.stringify(path.endsWith('/accounts') ? { accounts: [account], login: null }
        : path.endsWith(`/accounts/${account.id}`) ? account
        : { hasState: false, complete: true, steps: [], progress: { done: 0, total: 0 } }));
    };
    await act(() => root.render(h(UiProvider, null, h(Overview))));
    const label = `${controlSource(source.product).displayName}: ${t('connected')}`;
    for (const mode of ['tree', 'flat']) {
      await act(() => topologyMode.set(mode));
      assert.ok(page.getByRole('button', { name: label, exact: true }));
      assert.equal(page.queryByRole('button', { name: name => name.includes(local.label) || name.includes(controlSource('local-cli').displayName) }), null);
      assert.equal(page.queryByRole('button', { name: name => name.startsWith(source.label) }), null);
    }
  } finally { await fixture.close(); }
});

test('topology account labels survive reordering and animation frames settle after highlight and collapse', async () => {
  // Regression: unidentified labels collided and path wires jumped while node opacity was still springing.
  const fixture = await harness();
  try {
    const { server, root, mount, page, advance, settle, frames } = fixture;
    const { accountViews } = await server.ssrLoadModule('/ui/topology/accountViews.tsx');
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { viewModel } = await server.ssrLoadModule('/ui/acceptance.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const accounts = ['b', 'a'].map(id => ({ id, alias: 'Unidentified', sources: [], agentProfiles: [{ agent: 'codex' }] }));
    const platform = { id: 'codex', platform: 'codex', platformLabel: 'Codex', label: 'Codex', state: 'normal', selected: false, attention: false,
      content: h('button', null, 'Codex'), tasks: accounts.map(account => ({ id: `task-${account.id}`, agentAccountId: account.id,
        state: 'running', selected: false, width: 200, height: 60, content: h('button', null, `Task ${account.id}`) })) };
    const boundary = { current: mount };
    let opened: string | undefined;
    const actions = { open: (_side: number, _platform: string, _source?: string, account?: string) => { opened = account; } };
    const render = async (mode: string, order: string[]) => {
      const right = accountViews([platform], 1, accounts, mode, { '1:codex': order }, actions);
      const before = viewModel().topology;
      await act(() => root.render(h(Topology, { boundary, left: [], right, accountsEnabled: true, onReorderNodes() {}, onReorderTasks() {} })));
      if (before) for (const node of viewModel().topology.nodes) {
        const previous = before.nodes.find((old: any) => old.id === node.id);
        if (previous) assert.deepEqual([node.position.x, node.position.y], [previous.position.x, previous.position.y], 'Mode changes preserve in-flight positions');
      }
      await settle();
    };
    const snapshot = () => viewModel().topology;
    const names = new Map<string, string>();
    for (const mode of ['tree', 'flat', 'tree']) {
      await render(mode, mode === 'flat' ? ['a', 'b'] : ['b', 'a']);
      for (const account of accounts) {
        const node = snapshot().nodes.find((node: any) => node.accountId === account.id);
        const alias = mode === 'flat' ? node.label.slice(platform.platformLabel.length + 3) : node.label;
        if (names.has(account.id)) assert.equal(alias, names.get(account.id));
        names.set(account.id, alias);
        await act(() => fireEvent.click(page.getByRole('button', { name: node.label, exact: true })));
        assert.equal(opened, account.id);
      }
      assert.equal(new Set(names.values()).size, accounts.length);
    }
    const target = page.getByRole('button', { name: names.get('a')!, exact: true });
    const baseline = snapshot();
    const peer = baseline.nodes.find((node: any) => node.accountId === 'b');
    const bubble = baseline.tasks.find((task: any) => task.id === 'task-b');
    const unchangedPeer = () => {
      assert.deepEqual(snapshot().nodes.find((node: any) => node.id === peer.id).position, peer.position);
      assert.deepEqual(snapshot().tasks.find((task: any) => task.id === bubble.id).position, bubble.position);
    };
    const clear = () => {
      assert.equal(snapshot().interaction.hover, null);
      assert.equal(snapshot().interaction.focus, null);
      assert.ok(snapshot().nodes.every((node: any) => node.position.emphasis === 0));
      assert.ok(snapshot().tasks.every((task: any) => task.position.emphasis === 0));
    };
    for (const finish of ['leave', 'cancel', 'blur']) {
      await act(() => fireEvent.pointerOver(target));
      await advance();
      assert.ok(snapshot().nodes.find((node: any) => node.accountId === 'a').position.emphasis > 0);
      unchangedPeer();
      await act(() => {
        if (finish === 'leave') fireEvent.pointerOut(target);
        if (finish === 'cancel') fireEvent.pointerCancel(target);
        if (finish === 'blur') window.dispatchEvent(new Event('blur'));
      });
      await settle(); clear(); unchangedPeer();
    }
    await act(() => fireEvent.pointerOver(target)); await settle(); unchangedPeer();
    await act(() => fireEvent.pointerOut(target)); await settle(); clear();
    // Exercise both the SVG fan-out arc and its incoming connection mid-animation.
    for (const suffix of ['arc', 'connection']) {
      const path = page.getByLabelText(`${names.get('a')} ${suffix}`);
      for (const finish of ['pointerLeave', 'pointerCancel'] as const) {
        await act(() => fireEvent.pointerEnter(path)); await advance();
        assert.ok(snapshot().nodes.find((node: any) => node.accountId === 'a').position.emphasis > 0);
        await act(() => fireEvent[finish](path)); await settle(); clear();
      }
    }
    const taskButton = page.getByRole('button', { name: 'Task a', exact: true });
    for (const finish of ['pointerOut', 'pointerCancel'] as const) {
      await act(() => fireEvent.pointerOver(taskButton)); await advance();
      await act(() => fireEvent[finish](taskButton)); await settle(); clear();
    }
    const taskPath = page.getByLabelText('task-a connection');
    await act(() => fireEvent.pointerEnter(taskPath)); await advance();
    await act(() => fireEvent.pointerLeave(taskPath)); await settle(); clear();
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(() => fireEvent.pointerOver(page.getByRole('button', { name: 'Task a', exact: true }))); await advance();
      await act(() => fireEvent.click(page.getByRole('button', { name: `${t('topology.collapse')} ${platform.label}`, exact: true })));
      await settle();
      assert.equal(page.queryByRole('button', { name: 'Task a', exact: true }), null);
      assert.equal(snapshot().tasks.length, 0);
      clear();
      await act(() => fireEvent.click(page.getByRole('button', { name: `${t('topology.expand')} ${platform.label}`, exact: true })));
      await settle();
      assert.ok(page.getByRole('button', { name: 'Task a', exact: true }));
      assert.equal(snapshot().tasks.length, accounts.length);
    }
    await act(() => root.render(null));
    assert.equal(frames.size, 0, 'Unmount cancels scheduled animation');
  } finally { await fixture.close(); }
});


test('collapse controls remain reachable between node, arc and toggle and reveal for keyboard focus', async () => {
  // Regression: the collapse control vanished when the pointer crossed the gap from the node to its outer arc.
  const fixture = await harness();
  try {
    const { server, root, mount, page, settle } = fixture;
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { viewModel } = await server.ssrLoadModule('/ui/acceptance.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { nodeKey } = await server.ssrLoadModule('/ui/topology/animate.ts');
    const node = { id: 'platform', label: 'Platform', state: 'normal', attention: false, selected: false,
      content: h('button', null, 'Platform'), tasks: [{ id: 'bubble', width: 200, height: 60, state: 'running', content: h('button', null, 'Bubble') }] };
    await act(() => root.render(h(Topology, { boundary: { current: mount }, left: [], right: [node], accountsEnabled: true, onReorderNodes() {}, onReorderTasks() {} })));
    await settle();
    const state = () => viewModel().topology.interaction;
    const button = page.getByRole('button', { name: node.label, exact: true });
    const toggle = page.getByRole('button', { name: `${t('topology.collapse')} ${node.label}`, exact: true });
    const arc = page.getByLabelText(`${node.label} arc`);
    const wait = async (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
    await act(() => fireEvent.pointerOver(button));
    assert.equal(state().revealed, nodeKey(1, node.id));
    await act(() => fireEvent.pointerOut(button, { relatedTarget: arc }));
    await wait(100);
    assert.equal(state().revealed, nodeKey(1, node.id));
    await act(() => fireEvent.pointerEnter(arc));
    await wait(150);
    assert.equal(state().revealed, nodeKey(1, node.id));
    await act(() => fireEvent.pointerLeave(arc));
    await act(() => fireEvent.pointerOver(toggle));
    await wait(220);
    assert.equal(state().revealed, nodeKey(1, node.id));
    await act(() => fireEvent.pointerOut(toggle, { relatedTarget: button }));
    await wait(220);
    assert.equal(state().revealed, nodeKey(1, node.id));
    await act(() => fireEvent.pointerOut(button, { relatedTarget: arc }));
    await wait(250);
    assert.equal(state().revealed, null);
    await act(() => toggle.focus());
    assert.equal(state().focus.id, node.id);
    await act(() => fireEvent.keyDown(toggle, { key: 'Enter' }));
    await act(() => fireEvent.click(toggle));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    await act(() => toggle.blur()); await settle();
    assert.equal(state().focus, null);
    assert.equal(state().hover, null);
  } finally { await fixture.close(); }
});

test('collapse hit target surrounds its symbol at the mirrored arc midpoint', async () => {
  // Property: the toggle center bisects the outer arc and its hit target extends beyond the visible symbol in every direction.
  const { collapseTarget, deg } = await import('../ui/topology/solve.ts');
  for (const side of [-1, 1] as const) for (const radius of [22, 35, 48]) for (const [lo, hi] of [[-14, 14], [-58, 27], [-21, 58]]) {
    const target = collapseTarget(radius, lo, hi, side);
    assert.ok(Math.abs(Math.hypot(target.x, target.y) - radius) < 1e-8);
    assert.ok(Math.abs(Math.atan2(target.y, side * target.x) - deg((lo + hi) / 2)) < 1e-8);
    assert.ok(target.hitSize > target.symbolSize * 1.5);
  }
});

test('account tentacles use the task bubble taper and tangents', async () => {
  // Regression: account fan-outs used the wider primary root and different curvature from task bubbles.
  const fixture = await harness();
  try {
    const { server, root, mount, settle } = fixture;
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { viewModel } = await server.ssrLoadModule('/ui/acceptance.ts');
    const { grownWire } = await import('../ui/topology/geometry.ts');
    const { DEFAULTS, deg } = await import('../ui/topology/solve.ts');
    const node = (id: string) => ({ id, label: id, state: 'normal', attention: false, selected: false, content: h('button', null, id), tasks: [] });
    for (const side of [-1, 1] as const) {
      const parent = { ...node('platform'), children: [node('account-a'), node('account-b')],
        tasks: [{ id: 'bubble', width: 200, height: 60, state: 'running', content: h('button', null, 'Bubble') }] };
      await act(() => root.render(h(Topology, { boundary: { current: mount }, left: side === -1 ? [parent] : [], right: side === 1 ? [parent] : [], accountsEnabled: true, onReorderNodes() {}, onReorderTasks() {} })));
      await settle();
      const snapshot = viewModel().topology;
      const hub = snapshot.primitives.hub, source = snapshot.nodes.find((n: any) => n.id === parent.id).position;
      for (const item of [...snapshot.nodes.filter((n: any) => n.parent), ...snapshot.tasks]) {
        const v = item.position, account = 'size' in v;
        const end = { x: account ? v.x - side * (v.size / 2 * v.scale + 6) : v.x, y: v.y };
        const radial = { x: side * Math.cos(deg(v.port)), y: Math.sin(deg(v.port)) };
        const port = { x: source.x + source.radius * radial.x, y: source.y + source.radius * radial.y };
        const distance = Math.hypot(end.x - port.x, end.y - port.y);
        const c1 = { x: end.x - side * distance * DEFAULTS.t2End, y: end.y };
        const c2 = { x: port.x + radial.x * distance * DEFAULTS.t2Root, y: port.y + radial.y * distance * DEFAULTS.t2Root };
        const expected = grownWire(end, c1, c2, port, hub.Re / 130, DEFAULTS.flare, true);
        assert.ok(snapshot.paths.some((path: any) => path.d === expected.outline), `Shared task geometry for ${item.id}`);
      }
    }
  } finally { await fixture.close(); }
});


test('native history preserves confirmed, failed and unknown outcomes in its accessible state', async () => {
  // Regression: native history with null status was announced as completed instead of unconfirmed.
  const fixture = await harness();
  try {
    const { server, root, page } = fixture;
    const { default: Conversations } = await server.ssrLoadModule('/ui/components/AgentConversations.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const data = [null, 'failed', 'completed'].map((status, i) => ({ id: `native-${i}`, source: 'native', status, title: `History ${i}`, createdAt: new Date().toISOString() }));
    globalThis.fetch = async () => new Response(JSON.stringify({ data, nextCursor: null }));
    await act(async () => root.render(h(UiProvider, null, h(Conversations, { agent: 'claude', active: true }))));
    for (const [i, state] of ['unknown', 'failed', 'done'].entries()) {
      assert.equal(page.getByRole('button', { name: `History ${i} · ${t('timeline.open')}` }).getAttribute('aria-description'), t(`detail.state.${state}`));
    }
  } finally { await fixture.close(); }
});

test('single-account Agent panels retain native history and shared quota without weakening multi-account scope', async () => {
  // Regression: single-account panels filtered out unattributed Codex/DeepSeek history and hid the shared Cursor quota source.
  const fixture = await harness();
  try {
    const { server, root } = fixture;
    const { default: AgentPanel } = await server.ssrLoadModule('/ui/components/AgentPanel.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { accounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { subscriptions } = await server.ssrLoadModule('/ui/state/subscriptions.ts');
    const { selectAgentPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
    const { quotaValue } = await server.ssrLoadModule('/ui/subscriptions/displayPreferences.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const page = within(document.body), now = new Date().toISOString();
    const quotaWindow = (usedPercent: number) => ({ id: 'weekly', poolId: 'main', label: 'weekly', usedPercent, resetsAt: new Date(Date.now() + 86400000).toISOString() });
    for (const [agent, multiple] of [['codex', false], ['dsh', false], ['cursor', false], ['claude', true]] as const) {
      const account = { id: `account-${agent}`, alias: `Account ${agent}`, provider: agent, identityKey: `${agent}:example`, sources: [],
        agentProfiles: [{ agent, profileId: `profile-${agent}`, kind: 'cli-profile', state: 'signed-in', default: true }],
        notifications: { state: 'n/a', sessions: [] }, quota: { state: agent === 'codex' ? 'ready' : 'unavailable', windows: agent === 'codex' ? [quotaWindow(37)] : [] } };
      const peer = { ...account, id: 'account-other', alias: 'Other account' };
      const items = multiple ? [account, peer] : [account];
      const history = [{ id: 'unattributed', title: 'Unattributed native history' }, { id: 'owned', title: 'Selected account history', agentAccountId: account.id }, { id: 'foreign', title: 'Other account history', agentAccountId: peer.id }]
        .map(row => ({ ...row, source: 'native', createdAt: now }));
      const shared = { providerId: `shared-${agent}`, agentId: agent, agentIds: [agent], name: agent, eligible: true, state: 'ready', refreshing: false,
        observedAt: now, windows: [quotaWindow(53)], displayWindowId: 'weekly', blockedPoolIds: [], hasCredential: true, acceptsKey: false };
      let finishAccountLoad: (() => void) | undefined;
      globalThis.fetch = async input => {
        const route = String(input);
        if (multiple && route.endsWith('/accounts')) return new Promise<Response>(resolve => { finishAccountLoad = () => resolve(new Response(JSON.stringify({ accounts: items, login: null }))); });
        return new Response(JSON.stringify(route.endsWith('/accounts') ? { accounts: items, login: null }
          : items.find(a => route.endsWith(`/accounts/${a.id}`)) ?? (route.endsWith('/agents/conversations') ? { data: history, nextCursor: null } : {})));
      };
      await act(async () => {
        accounts.set({ items: multiple ? [] : items, login: null, loading: multiple, error: '' });
        subscriptions.set({ snapshot: { instanceId: 'fixture', revision: 1, settings: { enabled: true }, providers: [shared] }, error: '' });
        selectAgentPanel({ type: 'agent', agent, accountId: account.id });
        root.render(h(UiProvider, null, h(AgentPanel, { key: agent, agent: { agent, installed: true, enabled: true }, expanded: false, onSettings() {}, onPanelFrame() {}, onToggleWidth() {} })));
      });
      if (multiple) {
        const pendingDialog = within(page.getByRole('dialog'));
        assert.equal(pendingDialog.queryByRole('button', { name: `Unattributed native history · ${t('timeline.open')}` }), null);
        assert.equal(pendingDialog.queryByRole('button', { name: `Other account history · ${t('timeline.open')}` }), null);
        assert.ok(finishAccountLoad);
        await act(async () => finishAccountLoad!());
      }
      const dialog = within(page.getByRole('dialog'));
      const row = (title: string) => dialog.queryByRole('button', { name: `${title} · ${t('timeline.open')}`, exact: true });
      assert.ok(row('Selected account history'));
      if (multiple) {
        assert.equal(row('Unattributed native history'), null);
        assert.equal(row('Other account history'), null);
        assert.equal(dialog.queryByRole('meter'), null, 'a different account quota must not fill the selected account');
      } else {
        assert.ok(row('Unattributed native history'));
        assert.ok(row('Other account history'), 'the single-account entry exposes Agent-wide history without assigning ownership');
        const expected = agent === 'codex' ? account.quota.windows[0] : shared.windows[0];
        assert.equal(dialog.getByRole('meter').getAttribute('aria-valuenow'), String(quotaValue(expected)));
      }
      await act(async () => root.render(null));
    }
  } finally { await fixture.close(); }
});

test('conversation pagination retains loaded rows without repeating the loading status', async () => {
  // Regression: loading another history page flashed the timeline loading message beside already loaded conversations.
  const fixture = await harness(), originalObserver = globalThis.IntersectionObserver;
  try {
    const { server, root, page } = fixture;
    const { default: Conversations } = await server.ssrLoadModule('/ui/components/AgentConversations.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    let showNext: (() => void) | undefined, finishNext: ((response: Response) => void) | undefined;
    class PagingObserver {
      constructor(callback: IntersectionObserverCallback) {
        showNext = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {} unobserve() {} disconnect() {}
    }
    globalThis.IntersectionObserver = PagingObserver as unknown as typeof IntersectionObserver;
    const conversation = (id: string) => ({ id, source: 'native', status: 'completed', title: id, createdAt: new Date().toISOString() });
    globalThis.fetch = async (_input, init) => {
      const args = JSON.parse(String(init?.body ?? '{}'));
      if (args.cursor === 'later') return new Promise<Response>(resolve => { finishNext = resolve; });
      return new Response(JSON.stringify({ data: [conversation('First conversation')], nextCursor: 'later' }));
    };
    await act(async () => root.render(h(UiProvider, null, h(Conversations, { agent: 'claude', active: true }))));
    const row = (id: string) => page.getByRole('button', { name: `${id} · ${t('timeline.open')}` });
    assert.ok(row('First conversation'));
    assert.ok(showNext);
    await act(async () => showNext!());
    assert.ok(row('First conversation'));
    assert.equal(page.queryByRole('status'), null);
    assert.ok(finishNext);
    await act(async () => finishNext!(new Response(JSON.stringify({ data: [conversation('Next conversation')], nextCursor: null }))));
    assert.ok(row('First conversation'));
    assert.ok(row('Next conversation'));
    assert.equal(page.queryByRole('status'), null);
  } finally {
    await fixture.close();
    globalThis.IntersectionObserver = originalObserver;
  }
});

test('empty nodes hide disclosure controls even when an earlier collapse preference remains', async () => {
  // Regression: a stale collapse preference left plus/minus buttons on nodes without children or tasks.
  const fixture = await harness();
  try {
    const { default: Topology } = await fixture.server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { topologyCollapsed } = await fixture.server.ssrLoadModule('/ui/topology/accountState.ts');
    const { nodeKey } = await fixture.server.ssrLoadModule('/ui/topology/animate.ts');
    const { t } = await fixture.server.ssrLoadModule('/ui/i18n.ts');
    const node = { id: 'empty', label: 'Example Agent', side: 1, state: 'normal', attention: false, selected: false,
      content: h('button', null, 'Example Agent'), tasks: [] };
    const render = async (tasks: unknown[]) => {
      await act(() => fixture.root.render(h(Topology, { boundary: { current: fixture.mount }, left: [], right: [{ ...node, tasks }],
        accountsEnabled: true, onReorderNodes() {}, onReorderTasks() {} })));
      await fixture.settle();
    };
    for (const closed of [false, true]) {
      await act(() => topologyCollapsed.set({ [nodeKey(1, node.id)]: closed }));
      await render([]);
      assert.ok(fixture.page.getByRole('button', { name: node.label, exact: true }));
      for (const action of ['topology.expand', 'topology.collapse'])
        assert.equal(fixture.page.queryByRole('button', { name: `${t(action)} ${node.label}`, exact: true }), null);
    }
    await render([{ id: 'work', state: 'running', selected: false, width: 200, height: 60, content: h('button', null, 'Example task') }]);
    await act(() => fireEvent.click(fixture.page.getByRole('button', { name: `${t('topology.expand')} ${node.label}`, exact: true })));
    await fixture.settle();
    assert.ok(fixture.page.getByRole('button', { name: 'Example task', exact: true }));
  } finally { await fixture.close(); }
});

test('X keeps Grok and Grok Bot as separate entries of the same account', async () => {
  // Regression: f8eebf3 hid both Grok entry points inside a single X account node.
  const fixture = await harness();
  try {
    const { server, root, page } = fixture;
    const { default: Overview } = await server.ssrLoadModule('/ui/components/ConnectionOverview.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { agents } = await server.ssrLoadModule('/ui/state/agents.ts');
    const { topologyMode } = await server.ssrLoadModule('/ui/topology/accountState.ts');
    const sources = ['grok', 'grok-bot'].map(product => ({ id: `source-${product}`, ingressId: 'x-connection', product, platform: 'xai', label: product, credential: { type: 'ingress' }, state: 'connected' }));
    sources.push({ ...sources[0], id: 'second-grok-connection' });
    const ingress = { id: 'x-connection', sources, name: 'X connection', controlSource: 'grok', enabled: true, running: true, state: 'ready', auth: 'none', transport: 'https', error: '', config: { configured: true } };
    const account = { id: 'x-account', alias: 'Personal', provider: 'xai', identityKey: 'xai:example', sources: sources.map(source => source.id), agentProfiles: [], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } };
    connector.set({ status: { ingresses: [ingress], core: { backendSession: 'fixture' }, platform: 'darwin', logs: [] }, sources, sourcesLoaded: true, loading: false, busy: '', error: '', feedback: { text: '', error: false } });
    agents.set({ items: [], loading: false, error: '' });
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith('/accounts') ? { accounts: [account], login: null }
      : String(input).endsWith(`/accounts/${account.id}`) ? account : {}));
    await act(() => root.render(h(UiProvider, null, h(Overview))));
    const { ingressPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
    await act(() => topologyMode.set('tree'));
    assert.ok(page.getByRole('button', { name: 'X', exact: true }));
    for (const [product, label] of [['grok', 'Grok'], ['grok-bot', 'Grok Bot']]) {
      await act(() => fireEvent.click(page.getByRole('button', { name: label, exact: true })));
      assert.equal(ingressPanel.get()?.client?.id, `source-${product}`);
      await act(() => ingressPanel.set(undefined));
    }
    await act(() => topologyMode.set('flat'));
    assert.ok(page.getByRole('button', { name: 'X · Grok', exact: true }));
    assert.ok(page.getByRole('button', { name: 'X · Grok Bot', exact: true }));
    assert.equal(connector.get().sources.length, 3);
  } finally { await fixture.close(); }
});

test('merged source activity retains old and replacement connection history within its account', async () => {
  // Regression: account merges kept historical sources but the account task panel showed only one connection's dispatches.
  const fixture = await harness();
  try {
    const { server, root, page } = fixture;
    const { default: SourceDispatches } = await server.ssrLoadModule('/ui/components/SourceDispatches.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { accounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { tasks } = await server.ssrLoadModule('/ui/state/tasks.ts');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const account = { id: 'merged-account', alias: 'Personal', provider: 'xai', identityKey: 'xai:example', sources: ['old-connection-source', 'replacement-source', 'bot-source'], agentProfiles: [], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } };
    connector.set({ ...connector.get(), sources: [{ id: 'old-connection-source', product: 'grok', state: 'revoked' }, { id: 'replacement-source', product: 'grok', state: 'connected' }, { id: 'bot-source', product: 'grok-bot', state: 'connected' }] });
    const records = ['old-connection-source', 'replacement-source', 'bot-source', 'unrelated-source'].map((source, index) => ({ requestId: `dispatch-${index}`, origin: { sourceId: source }, state: 'completed', createdAt: new Date().toISOString(), task: { kind: 'create', title: `History ${source}`, prompt: '', input: {}, settings: {} } }));
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith('/accounts') ? { accounts: [account], login: null } : account));
    accounts.set({ items: [account], login: null, loading: false, error: '' });
    tasks.set({ records, loading: false, error: '' });
    await act(() => root.render(h(UiProvider, null, h(SourceDispatches, { sourceId: 'replacement-source' }))));
    assert.ok(page.getByRole('button', { name: /History old-connection-source/ }));
    assert.ok(page.getByRole('button', { name: /History replacement-source/ }));
    assert.equal(page.queryByRole('button', { name: /History unrelated-source/ }), null);
    assert.equal(page.queryByRole('button', { name: /History bot-source/ }), null);
    await act(() => root.render(h(UiProvider, null, h(SourceDispatches, { sourceId: 'bot-source' }))));
    assert.ok(page.getByRole('button', { name: /History bot-source/ }));
    assert.equal(page.queryByRole('button', { name: /History replacement-source/ }), null);
  } finally { await fixture.close(); }
});

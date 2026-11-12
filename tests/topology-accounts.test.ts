import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

async function harness(readOnly = false) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  const window = new Window({ url: 'http://localhost' });
  if (readOnly) window.document.documentElement.setAttribute('data-arc-browser', '');
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0, time = 0;
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, location: window.location, history: window.history, HTMLElement: window.HTMLElement, Element: window.Element,
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
  const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
  const nativeRoot = createRoot(mount), page = within(mount);
  const root = { render: (content: Parameters<typeof nativeRoot.render>[0]) => nativeRoot.render(h(TooltipProvider, null, content)), unmount: () => nativeRoot.unmount() };
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

test('single-source layouts preserve independent connector names', async () => {
  // Regression: connector instances were collapsed into account nodes and lost their custom names.
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
    const label = source.label;
    for (const mode of ['tree', 'flat']) {
      await act(() => topologyMode.set(mode));
      await fixture.settle();
      assert.ok(page.getByRole('button', { name: label, exact: true }));
      assert.equal(page.queryByRole('button', { name: name => name.includes(local.label) || name.includes(controlSource('local-cli').displayName) }), null);
      assert.equal(page.getAllByRole('button', { name: label, exact: true }).length, 1);
    }
  } finally { await fixture.close(); }
});



test('arc actions start on the arc and fan outward symmetrically with evenly spaced centers', async () => {
  // Property: action origins stay on their owner arc while expanded centers preserve mirroring, ordering and equal separation.
  const { arcActionPositions } = await import('../ui/topology/geometry.ts');
  for (const radius of [22, 35, 48]) for (const [lo, hi] of [[-14, 14], [-58, 27], [-21, 58]]) for (const count of [1, 2, 3]) {
    const left = arcActionPositions({ kind: 'arc', x: 0, y: 0, radius, lo, hi, side: -1 }, count);
    const right = arcActionPositions({ kind: 'arc', x: 0, y: 0, radius, lo, hi, side: 1 }, count);
    const distances: number[] = [];
    for (const [index, point] of right.entries()) {
      assert.ok(Math.abs(Math.hypot(point.x, point.y) - radius) < 1e-8);
      assert.ok(Math.hypot(point.x + point.dx, point.y + point.dy) > radius);
      assert.equal(left[index].x, -point.x); assert.equal(left[index].dx, -point.dx);
      assert.equal(left[index].y, point.y); assert.equal(left[index].dy, point.dy);
      if (index) {
        const previous = right[index - 1];
        distances.push(Math.hypot(point.x + point.dx - previous.x - previous.dx, point.y + point.dy - previous.y - previous.dy));
      }
    }
    assert.ok(distances.every(distance => distance > 0 && Math.abs(distance - distances[0]) < 1e-8));
  }
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
    const { default: AgentPanelView } = await server.ssrLoadModule('/ui/components/AgentPanel.tsx');
    const AgentPanel = (props: Record<string, unknown>) => h(AgentPanelView, { ...props, selection: agentPanel.use(), active: true });
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { accounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { subscriptions } = await server.ssrLoadModule('/ui/state/subscriptions.ts');
    const { agentPanel, selectAgentPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
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


test('provider grouping keeps Grok and Grok Bot as separate connector entries', async () => {
  // Regression: f8eebf3 hid both Grok entry points inside a single X account node.
  const fixture = await harness();
  try {
    const { server, root, page } = fixture;
    const { default: Overview } = await server.ssrLoadModule('/ui/components/ConnectionOverview.tsx');
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { agents } = await server.ssrLoadModule('/ui/state/agents.ts');
    const { topologyMode } = await server.ssrLoadModule('/ui/topology/accountState.ts');
    const sources = ['grok', 'grok-bot'].map(product => ({ id: `source-${product}`, ingressId: 'x-connection', product, platform: 'xai', label: product === 'grok' ? 'Grok' : 'Grok Bot', credential: { type: 'ingress' }, state: 'connected' }));
    sources.push({ ...sources[0], id: 'second-grok-connection', label: 'Grok secondary' });
    const ingress = { id: 'x-connection', sources, name: 'X connection', controlSource: 'grok', enabled: true, running: true, state: 'ready', auth: 'none', transport: 'https', error: '', config: { configured: true } };
    const account = { id: 'x-account', alias: 'Personal', provider: 'xai', identityKey: 'xai:example', sources: sources.map(source => source.id), agentProfiles: [], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } };
    connector.set({ status: { ingresses: [ingress], core: { backendSession: 'fixture' }, platform: 'darwin', logs: [] }, sources, sourcesLoaded: true, loading: false, busy: '', error: '', feedback: { text: '', error: false } });
    agents.set({ items: [], loading: false, error: '' });
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith('/accounts') ? { accounts: [account], login: null }
      : String(input).endsWith(`/accounts/${account.id}`) ? account : {}));
    await act(() => root.render(h(UiProvider, null, h(Overview))));
    const { ingressPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
    await act(() => topologyMode.set('tree'));
    const { controlSourcePlatform } = await server.ssrLoadModule('/ui/controlSources.ts');
    assert.ok(page.getByRole('button', { name: controlSourcePlatform('grok').displayName, exact: true }));
    for (const [product, label] of [['grok', 'Grok'], ['grok-bot', 'Grok Bot']]) {
      await act(() => fireEvent.click(page.getByRole('button', { name: label, exact: true })));
      assert.equal(ingressPanel.get()?.client?.id, `source-${product}`);
      await act(() => ingressPanel.set(undefined));
    }
    await act(() => topologyMode.set('flat'));
    assert.ok(page.getByRole('button', { name: 'Grok', exact: true }));
    assert.ok(page.getByRole('button', { name: 'Grok Bot', exact: true }));
    await act(() => fireEvent.click(page.getByRole('button', { name: 'Grok secondary', exact: true })));
    assert.equal(ingressPanel.get()?.client?.id, 'second-grok-connection');
  } finally { await fixture.close(); }
});

test('connector activity does not combine other instances of the same account', async () => {
  // Regression: source activity combined distinct connector histories through shared account membership.
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
    assert.equal(page.queryByRole('button', { name: /History old-connection-source/ }), null);
    assert.ok(page.getByRole('button', { name: /History replacement-source/ }));
    assert.equal(page.queryByRole('button', { name: /History unrelated-source/ }), null);
    assert.equal(page.queryByRole('button', { name: /History bot-source/ }), null);
    await act(() => root.render(h(UiProvider, null, h(SourceDispatches, { sourceId: 'bot-source' }))));
    assert.ok(page.getByRole('button', { name: /History bot-source/ }));
    assert.equal(page.queryByRole('button', { name: /History replacement-source/ }), null);
  } finally { await fixture.close(); }
});

test('read-only Agent roots without provider accounts still expose their native task history', async () => {
  // Regression: browser-readonly opened a native-account placeholder with no route to its running tasks.
  const fixture = await harness(true);
  try {
    const { server, root } = fixture;
    const { default: AgentPanelView } = await server.ssrLoadModule('/ui/components/AgentPanel.tsx');
    const AgentPanel = (props: Record<string, unknown>) => h(AgentPanelView, { ...props, selection: agentPanel.use(), active: true });
    const { default: UiProvider } = await server.ssrLoadModule('/ui/components/UiProvider.tsx');
    const { accounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { agentPanel, selectAgentPanel } = await server.ssrLoadModule('/ui/state/overviewPanels.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).endsWith('/agents/conversations')
      ? { data: [{ id: 'native-history', title: 'Verify remote status', source: 'native', createdAt: new Date().toISOString() }], nextCursor: null }
      : String(input).endsWith('/accounts') ? { accounts: [], login: null } : {}));
    await act(async () => {
      accounts.set({ items: [], login: null, loading: false, error: '' });
      selectAgentPanel({ type: 'platform', agent: 'codex' });
      root.render(h(UiProvider, null, h(AgentPanel, { agent: { agent: 'codex', installed: true, enabled: true }, expanded: false, onSettings() {}, onPanelFrame() {}, onToggleWidth() {} })));
    });
    assert.ok(within(within(document.body).getByRole('dialog')).getByRole('button', { name: `Verify remote status · ${t('timeline.open')}`, exact: true }));
  } finally { await fixture.close(); }
});

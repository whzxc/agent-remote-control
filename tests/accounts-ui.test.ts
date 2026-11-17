import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer, type ViteDevServer } from 'vite';
import type { Root } from 'react-dom/client';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

async function withAccountUI(run: (context: { window: Window; server: ViteDevServer; root: Root }) => Promise<void>) {
  const window = new Window({ url: 'http://localhost/?scenario=accounts' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, location: window.location, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS,
    localStorage: window.localStorage, ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Account scenario contacted real Core'); };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('accounts');
    await run({ window, server, root });
  } finally {
    await act(async () => root.unmount());
    await server.close(); globalThis.fetch = originalFetch; await window.happyDOM.abort();
  }
}

test('platform workspace lists connector instances and excludes local Agent identities', async () => {
  // Recurring bug class: the account workspace merged connector instances and included locally discovered Agents.
  await withAccountUI(async ({ server, root }) => {
    const { default: PlatformsPage } = await server.ssrLoadModule('/ui/components/PlatformsPage.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { controlSourcePlatform } = await server.ssrLoadModule('/ui/controlSources.ts');
    assert.equal(controlSourcePlatform('github-copilot').id, 'microsoft');
    const { setPrivacy } = await server.ssrLoadModule('/ui/state/privacy.ts');
    setPrivacy(false);
    const original = connector.get();
    const source = { id: 'first', ingressId: 'test', product: 'claude', platform: 'anthropic', label: 'First connector', authorizationFacts: { email: 'connector@example.com', orgName: 'Connector team' }, createdAt: '2026-01-01T00:00:00Z', connectedAt: 1, lastSeenAt: null, credential: { type: 'oauth-grant' }, state: 'connected' };
    connector.set({ ...original, sourcesLoaded: true, sources: [source, { ...source, id: 'second', label: 'Second connector', authorizationFacts: undefined }, { ...source, id: 'retired', label: 'Retired connector', state: 'revoked' }] });
    navigation.set({ page: 'accounts', platformId: 'anthropic' });
    await act(() => root.render(h(TooltipProvider, null, h(PlatformsPage))));
    const page = within(document.body);
    assert.ok(page.getByRole('region', { name: source.label }));
    const first = within(page.getByRole('region', { name: source.label }));
    assert.ok(first.getByText('connector@example.com'));
    const second = within(page.getByRole('region', { name: 'Second connector' }));
    assert.equal(second.queryByText('connector@example.com'), null);
    assert.equal(page.queryByRole('region', { name: 'Retired connector' }), null);
    assert.ok(page.getByRole('radio', { name: 'Cursor', exact: true }));
    assert.equal(page.queryByRole('radio', { name: 'GitHub', exact: true }), null);
    assert.ok(page.getByRole('radio', { name: 'Microsoft', exact: true }));
    await act(() => fireEvent.click(page.getByRole('radio', { name: 'Google' })));
    assert.equal(page.queryByRole('region', { name: source.label }), null);
    assert.ok(page.getByRole('region', { name: 'Google' }));
  });
});

test('source dates treat zero and absent timestamps as never in every locale', async () => {
  // Recurring bug class: Last seen displayed a date in 1970 when the native timestamp was zero.
  await withAccountUI(async ({ server }) => {
    const { sourceDate } = await server.ssrLoadModule('/ui/sourcePresentation.ts');
    const { locale } = await server.ssrLoadModule('/ui/i18n.ts');
    for (const language of ['en', 'zh-CN']) {
      locale.set(language);
      assert.equal(sourceDate(0), sourceDate(null));
      assert.equal(sourceDate(undefined), sourceDate(null));
      assert.ok(!sourceDate(0).includes('1970'));
      assert.notEqual(sourceDate(1760000000), sourceDate(null));
    }
  });
});

test('built-in local authority is absent from control sources, accounts and disconnect actions', async () => {
  // Recurring bug class: Local CLI appeared as an Unidentified account and its disconnect action revoked panel and CLI writes.
  await withAccountUI(async ({ server, root }) => {
    const { connector, orderedSources } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { accounts, refreshAccounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { default: PlatformsPage } = await server.ssrLoadModule('/ui/components/PlatformsPage.tsx');
    const { default: ConnectionsContent } = await server.ssrLoadModule('/ui/components/ConnectionsContent.tsx');
    const { default: SourcePanel } = await server.ssrLoadModule('/ui/components/SourcePanel.tsx');
    const { default: SourceProductChoice } = await server.ssrLoadModule('/ui/components/SourceProductChoice.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const local = { ...connector.get().sources[0], id: 'example-local', ingressId: 'local-cli', credential: { type: 'local' }, product: 'local-cli', platform: 'local', label: 'Local authority fixture', state: 'connected' };
    connector.set((old: any) => ({ ...old, sources: [...old.sources, local] }));
    assert.ok(!orderedSources().some((source: any) => source.id === local.id));
    const external = connector.get().sources.find((source: any) => source.id !== local.id);
    assert.ok(orderedSources().some((source: any) => source.id === external.id));
    const list = accountsApi.list, get = accountsApi.get;
    const legacy = { ...await get('account-source'), id: 'example-local-account', alias: 'Local account fixture', sources: [local.id], agentProfiles: [] };
    accountsApi.list = async () => { const value = await list(); return { ...value, accounts: [...value.accounts, legacy] }; };
    accountsApi.get = async (id: string) => id === legacy.id ? legacy : get(id);
    const page = within(document.body);
    const render = async (node: any) => { await act(async () => root.render(h(TooltipProvider, null, node))); };
    try {
      await refreshAccounts();
      assert.ok(!accounts.get().items.some((account: any) => account.id === legacy.id));
      assert.ok(accounts.get().items.some((account: any) => account.sources.includes(external.id)));
      await render(h(PlatformsPage));
      assert.equal(page.queryByRole('button', { name: name => name.includes(legacy.alias) }), null);
      await render(null);
      navigation.set((old: any) => ({ ...old, remoteSourceId: local.id, remoteConnectionId: undefined }));
      await render(h(ConnectionsContent));
      assert.equal(page.queryByRole('img', { name: local.label, exact: true }), null);
      const connection = connector.get().status.ingresses.find((entry: any) => entry.transport !== 'local');
      assert.ok(page.getByRole('region', { name: connection.name, exact: true }));
      assert.equal(page.queryByRole('button', { name: t('addControlSource'), exact: true }), null);
      assert.equal(page.queryByRole('button', { name: t('source.disconnect'), exact: true }), null);
      await render(h(SourcePanel, { source: local }));
      assert.equal(page.queryByRole('button', { name: t('source.disconnect'), exact: true }), null);
      await render(h(SourceProductChoice, { value: 'custom', onChange() {} }));
      const { controlSource } = await server.ssrLoadModule('/ui/controlSources.ts');
      await act(async () => { fireEvent.click(page.getByRole('combobox', { name: t('source.moreProducts'), exact: true })); });
      assert.ok(page.getByRole('option', { name: controlSource('chatgpt').shortName, exact: true }));
      assert.equal(page.queryByRole('option', { name: controlSource('local-cli').shortName, exact: true }), null);
      assert.equal(page.queryByRole('radio', { name: controlSource('local-cli').shortName, exact: true }), null);
    } finally { accountsApi.list = list; accountsApi.get = get; }
  });
});

test('connector removal revokes only the selected instance and retains the device connection', async () => {
  // Recurring bug class: platform connector cards had no removal action for obsolete authorizations.
  await withAccountUI(async ({ server, root }) => {
    const { default: PlatformsPage } = await server.ssrLoadModule('/ui/components/PlatformsPage.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { controlSourcePlatform } = await server.ssrLoadModule('/ui/controlSources.ts');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const source = connector.get().sources.find((item: any) => item.credential.type !== 'local');
    assert.ok(source);
    const connectionIds = connector.get().status.ingresses.map((item: any) => item.id);
    const otherIds = connector.get().sources.filter((item: any) => item.id !== source.id && item.state !== 'revoked').map((item: any) => item.id);
    navigation.set({ platformId: controlSourcePlatform(source.product).id });
    await act(() => root.render(h(TooltipProvider, null, h(PlatformsPage))));
    const page = within(document.body);
    await act(() => fireEvent.click(page.getByRole('button', { name: t('platforms.remove', { name: source.label }), exact: true })));
    await act(() => fireEvent.click(within(page.getByRole('dialog')).getByRole('button', { name: t('cancel'), exact: true })));
    assert.notEqual(connector.get().sources.find((item: any) => item.id === source.id).state, 'revoked');
    await act(() => fireEvent.click(page.getByRole('button', { name: t('platforms.remove', { name: source.label }), exact: true })));
    await act(async () => fireEvent.click(within(page.getByRole('dialog')).getByRole('button', { name: t('remove'), exact: true })));
    assert.equal(connector.get().sources.find((item: any) => item.id === source.id).state, 'revoked');
    assert.equal(page.queryByRole('region', { name: source.label }), null);
    assert.deepEqual(connector.get().status.ingresses.map((item: any) => item.id), connectionIds);
    assert.deepEqual(connector.get().sources.filter((item: any) => item.id !== source.id && item.state !== 'revoked').map((item: any) => item.id), otherIds);
  });
});

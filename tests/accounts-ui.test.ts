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

test('account management retains native login evidence and notification targets', async () => {
  // Regression: the account UI used invented detail/polling/notification routes and treated unsupported native login as successful.
  await withAccountUI(async ({ server, root }) => {
    const { api, accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const list = await accountsApi.list();
    assert.equal(list.login, null);
    assert.ok(list.accounts.every((a: Record<string, unknown>) => !('email' in a) && !('orgName' in a)));
    assert.equal((await accountsApi.get('account-claude')).email, 'alex@example.com');
    assert.equal((await accountsApi.get('account-source')).alias, 'Unidentified');
    assert.deepEqual((await accountsApi.get('account-source')).agentProfiles, []);
    assert.equal((await accountsApi.query({ id: 'account-claude' })).id, 'account-claude');
    await accountsApi.update({ id: 'account-claude', alias: 'Example team' });
    assert.equal((await accountsApi.get('account-claude')).alias, 'Example team');
    await accountsApi.update({ id: 'account-review', defaultFor: 'claude' });
    assert.equal((await accountsApi.list()).accounts.flatMap((a: any) => a.agentProfiles).filter((p: any) => p.agent === 'claude' && p.default).length, 1);

    const claude = await accountsApi.reauth({ id: 'account-review', agent: 'claude' });
    assert.deepEqual(await accountsApi.login({ loginId: claude.loginId, action: 'code', code: 'example-code' }), { submitted: true });
    assert.equal((await accountsApi.list()).login.state, 'completed');
    assert.equal((await accountsApi.get('account-review')).agentProfiles[0].state, 'signed-in');
    await accountsApi.route({ accountId: 'account-review', target: 'session_010000000000000000000002' });
    await accountsApi.notify('account-review', 'test', { target: 'session_010000000000000000000002' });
    const notified = await accountsApi.get('account-review');
    assert.equal(notified.notifications.sessions[0].target, 'session_010000000000000000000002');
    assert.equal(notified.notifications.sessions[0].lastDelivery.status, 'sent');
    assert.equal(notified.notifications.state, 'not-bound');
    assert.equal(notified.notifications.reachable, false);
    await assert.rejects(accountsApi.notify('account-source', 'test', { target: 'session_010000000000000000000002' }), /ACCOUNT_AGENT_MISSING/);

    const codex = await accountsApi.add({ kind: 'codex' });
    await assert.rejects(accountsApi.login({ loginId: codex.loginId, action: 'code', code: 'example-code' }), /ACCOUNT_LOGIN_CODE_UNSUPPORTED/);
    for (let i = 0; i < 4; i++) await accountsApi.list();
    assert.equal((await accountsApi.list()).login.accountId, 'account-openai');

    const key = await accountsApi.add({ kind: 'api-key' });
    assert.equal(key.state, 'unfinished');
    assert.ok(key.next.message);
    for (let i = 0; i < 5; i++) assert.equal((await accountsApi.list()).login.state, 'unfinished');
    assert.equal((await accountsApi.get('account-key')).agentProfiles[0].state, 'unfinished');
    const detected = await accountsApi.add({ kind: 'detect' });
    assert.equal(detected.state, 'completed');
    assert.equal(detected.accountId, undefined);
    const removed = await accountsApi.remove({ id: 'account-review', running: 'finish' });
    assert.equal(removed.health.state, 'removed');
    assert.equal((await accountsApi.get(removed.id)).displayName, 'Removed account · Review');
    assert.ok(!(await accountsApi.list()).accounts.some((a: any) => a.id === removed.id));
    await assert.rejects(api('accounts/login?loginId=example', 'GET'), /SCENARIO_ACTION_UNAVAILABLE/);
    await assert.rejects(api('accounts/bind', 'POST', { id: 'account-claude', target: 'example' }), /SCENARIO_ACTION_UNAVAILABLE/);
  });
});

test('platform workspace lists connector instances and excludes local Agent identities', async () => {
  // Regression: the account workspace merged connector instances and included locally discovered Agents.
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
    assert.equal(page.queryByRole('radio', { name: 'Cursor' }), null);
    assert.equal(page.queryByRole('radio', { name: 'GitHub', exact: true }), null);
    assert.ok(page.getByRole('radio', { name: 'Microsoft', exact: true }));
    await act(() => fireEvent.click(page.getByRole('radio', { name: 'Google' })));
    assert.equal(page.queryByRole('region', { name: source.label }), null);
    assert.ok(page.getByRole('region', { name: 'Google' }));
  });
});

test('source dates treat zero and absent timestamps as never in every locale', async () => {
  // Regression: Last seen displayed a date in 1970 when the native timestamp was zero.
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
  // Regression: Local CLI appeared as an Unidentified account and its disconnect action revoked panel and CLI writes.
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
      assert.equal(page.queryByRole('button', { name: name => name.includes(local.label) }), null);
      const connection = connector.get().status.ingresses.find((entry: any) => entry.transport !== 'local');
      assert.ok(page.getByRole('button', { name: name => name.startsWith(connection.name) && name.includes(t('connect.online')) }));
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

test('connection management exposes connections without source or platform administration', async () => {
  // Regression: connection management mixed duplicate source/account rows and platform grouping with connection lifecycle actions.
  await withAccountUI(async ({ server, root }) => {
    const { default: ConnectionsContent } = await server.ssrLoadModule('/ui/components/ConnectionsContent.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    navigation.set((old: any) => ({ ...old, page: 'overview', connectionsOpen: true, remoteSourceId: undefined, remoteConnectionId: undefined }));
    await act(() => root.render(h(TooltipProvider, null, h(ConnectionsContent))));
    const page = within(document.body);
    assert.ok(page.getByRole('button', { name: t('source.newConnection'), exact: true }));
    assert.equal(page.queryByRole('button', { name: t('addControlSource'), exact: true }), null);
    assert.equal(page.queryByRole('radiogroup', { name: t('source.grouping') }), null);
    const connection = connector.get().status.ingresses.find((entry: any) => entry.transport !== 'local');
    await act(() => fireEvent.click(page.getByRole('button', { name: name => name.startsWith(connection.name) && name.includes(t('connect.online')) })));
    assert.ok(page.getByRole('heading', { name: connection.name, exact: true }));
    assert.equal(page.queryByRole('button', { name: t('setup.addSourceForConnection'), exact: true }), null);
    assert.ok(page.getByRole('button', { name: t('edit'), exact: true }));
  });
});

test('connector removal revokes only the selected instance and retains the device connection', async () => {
  // Regression: platform connector cards had no removal action for obsolete authorizations.
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

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

test('account UI uses native routes, login evidence and notification targets', async () => {
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
    const { default: AddAccount } = await server.ssrLoadModule('/ui/components/AddAccount.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const page = within(document.body);
    await act(async () => root.render(h(TooltipProvider, null, h(AddAccount, { initialLogin: codex, onClose() {} }))));
    assert.equal(page.queryByText(t('claudeAccounts.enterCode')), null);
    assert.equal(page.queryByRole('button', { name: t('accounts.confirm'), exact: true }), null);
    await act(async () => root.render(null));
    for (let i = 0; i < 4; i++) await accountsApi.list();
    assert.equal((await accountsApi.list()).login.accountId, 'account-openai');

    const key = await accountsApi.add({ kind: 'api-key' });
    assert.equal(key.state, 'unfinished');
    assert.ok(key.next.message);
    await act(async () => root.render(h(TooltipProvider, null, h(AddAccount, { initialLogin: key, onClose() {} }))));
    assert.ok(page.getByText(key.next.message));
    assert.equal(page.queryByText(t('claudeAccounts.enterCode')), null);
    assert.equal(page.queryByRole('button', { name: t('accounts.confirm'), exact: true }), null);
    assert.ok(page.getByRole('button', { name: t('accounts.kind.detect'), exact: true }));
    await act(async () => root.render(null));
    for (let i = 0; i < 5; i++) assert.equal((await accountsApi.list()).login.state, 'unfinished');
    assert.equal((await accountsApi.get('account-key')).agentProfiles[0].state, 'unfinished');
    const detected = await accountsApi.add({ kind: 'detect' });
    assert.equal(detected.state, 'completed');
    assert.equal(detected.accountId, undefined);
    await act(async () => root.render(h(TooltipProvider, null, h(AddAccount, { initialLogin: detected, onClose() {} }))));
    assert.equal(page.queryByRole('button', { name: t('accounts.confirm'), exact: true }), null);
    await act(async () => root.render(null));

    const removed = await accountsApi.remove({ id: 'account-review', running: 'finish' });
    assert.equal(removed.health.state, 'removed');
    assert.equal((await accountsApi.get(removed.id)).displayName, 'Removed account · Review');
    assert.ok(!(await accountsApi.list()).accounts.some((a: any) => a.id === removed.id));
    await assert.rejects(api('accounts/login?loginId=example', 'GET'), /SCENARIO_ACTION_UNAVAILABLE/);
    await assert.rejects(api('accounts/bind', 'POST', { id: 'account-claude', target: 'example' }), /SCENARIO_ACTION_UNAVAILABLE/);
  });
});

test('account details save or cancel inline aliases and expose Agent sign-in for unresolved sources', async () => {
  // Regression: account headers were permanent inputs without cancellation and unresolved accounts hid the only Add Agent action.
  await withAccountUI(async ({ server, root }) => {
    const { accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const { refreshAccounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { default: AccountsPage } = await server.ssrLoadModule('/ui/components/AccountsPage.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    await refreshAccounts();
    const account = await accountsApi.get('account-claude');
    navigation.set((old: any) => ({ ...old, accountId: account.id }));
    const page = within(document.body);
    await act(async () => root.render(h(TooltipProvider, null, h(AccountsPage))));
    const edit = async (alias: string, draft: string) => {
      await act(async () => { fireEvent.click(page.getByRole('button', { name: t('accounts.editAlias', { alias }), exact: true })); });
      const input = page.getByRole('textbox', { name: t('accounts.alias'), exact: true });
      assert.ok(input.matches(':focus'));
      await act(async () => { fireEvent.change(input, { target: { value: draft } }); });
      return input;
    };
    let input = await edit(account.alias, 'Cancelled alias');
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); fireEvent.blur(input); });
    assert.equal((await accountsApi.get(account.id)).alias, account.alias);
    assert.ok(page.getByRole('button', { name: t('accounts.editAlias', { alias: account.alias }), exact: true }).matches(':focus'));
    input = await edit(account.alias, '  Renamed account  ');
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    assert.equal((await accountsApi.get(account.id)).alias, 'Renamed account');
    assert.ok(page.getByRole('button', { name: t('accounts.editAlias', { alias: 'Renamed account' }), exact: true }).matches(':focus'));
    input = await edit('Renamed account', 'Blur saved');
    await act(async () => { page.getByRole('button', { name: t('remove'), exact: true }).focus(); });
    assert.equal((await accountsApi.get(account.id)).alias, 'Blur saved');
    assert.ok(page.getByRole('button', { name: t('remove'), exact: true }).matches(':focus'));
    input = await edit('Blur saved', '   ');
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal((await accountsApi.get(account.id)).alias, 'Blur saved');
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });

    await act(async () => navigation.set((old: any) => ({ ...old, accountId: 'account-source' })));
    await act(async () => { fireEvent.click(page.getByRole('button', { name: t('accounts.addAgent'), exact: true })); });
    assert.ok(page.getByRole('dialog', { name: t('accounts.addAgentFor', { alias: (await accountsApi.get('account-source')).alias }), exact: true }));
    await act(async () => { fireEvent.click(page.getByRole('button', { name: t('accounts.signin'), exact: true })); });
    const login = (await accountsApi.list()).login;
    assert.equal(login.kind, 'claude');
    assert.equal(login.state, 'waiting');
    await act(async () => root.render(null));
    await accountsApi.login({ loginId: login.loginId, action: 'cancel' });
  });
});

test('notification sessions retain individual reachability and send tests to the selected destination', async () => {
  // Regression: account notifications lacked per-session reachability and card actions could not be checked against a selected destination.
  await withAccountUI(async ({ server, root }) => {
    const { accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const { AccountNotifications } = await server.ssrLoadModule('/ui/components/AccountCards.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { setPrivacy } = await server.ssrLoadModule('/ui/state/privacy.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const accountId = 'account-claude', target = 'session_010000000000000000000003';
    await accountsApi.route({ accountId, target });
    const account = await accountsApi.get(accountId);
    await act(async () => setPrivacy(false));
    const render = async (value: any) => { await act(async () => root.render(h(TooltipProvider, null, h(AccountNotifications, { account: value })))); };
    await render(account);
    const page = within(document.body), list = page.getByRole('list', { name: t('accounts.sessions'), exact: true });
    const rows = within(list).getAllByRole('listitem');
    const selected = rows.find(row => within(row).queryByText(target, { exact: true }))!;
    assert.ok(within(rows[0]).getByText(t('accounts.session.verified'), { exact: true }));
    assert.ok(within(selected).getByText(t('accounts.session.not-bound'), { exact: true }));
    await act(async () => { fireEvent.click(within(selected).getByRole('button', { name: t('accounts.sendTest'), exact: true })); });
    const updated = await accountsApi.get(accountId);
    assert.equal(updated.notifications.sessions.find((session: any) => session.target === target).lastDelivery.status, 'sent');
    assert.notEqual(updated.notifications.sessions.find((session: any) => session.target === target).verified, true);
    await render(updated);
    assert.ok(within(page.getByRole('list', { name: t('accounts.sessions'), exact: true })).getByText(t('accounts.session.not-bound'), { exact: true }));
    const mcp = { ...updated, notifications: { state: 'mcp-events', reachable: true, sessions: [
      { target: 'example-events-active', channel: 'mcp-events', state: 'reachable' },
      { target: 'example-events-unavailable', channel: 'mcp-events', state: 'unavailable' },
    ] } };
    await render(mcp);
    assert.ok(page.getByText(t('accounts.session.reachable'), { exact: true }));
    assert.ok(page.getByText(t('accounts.session.unavailable'), { exact: true }));
    assert.equal(page.queryByRole('button', { name: t('accounts.sendTest'), exact: true }), null);
  });
});

test('notification sessions omit empty targets from account state and bound session actions', async () => {
  // Regression: Local CLI Unidentified accounts rendered an unregistered empty target as a bound notification session.
  await withAccountUI(async ({ server, root }) => {
    const { accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const { accounts, refreshAccounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    const { AccountNotifications } = await server.ssrLoadModule('/ui/components/AccountCards.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { setPrivacy } = await server.ssrLoadModule('/ui/state/privacy.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const get = accountsApi.get;
    const source = await get('account-source'), agent = await get('account-claude');
    const empty = { sourceId: source.sources[0], channel: 'claude-session', registered: false, verified: false, state: 'unverified', target: '' };
    let sessions = [empty, { ...empty, target: ' \t ' }];
    const notificationAccount = (account: any) => ({ ...account, notifications: { ...account.notifications, sessions } });
    accountsApi.get = async (id: string) => notificationAccount(await get(id));
    try {
      await refreshAccounts();
      assert.ok(accounts.get().items.every((account: any) => account.notifications.sessions.length === 0));
      await act(async () => setPrivacy(false));
      const page = within(document.body);
      const render = async (account: any) => { await act(async () => root.render(h(TooltipProvider, null, h(AccountNotifications, { account })))); };
      for (const account of [source, agent]) {
        await render(notificationAccount(account));
        assert.ok(page.getByRole('heading', { name: t('accounts.notifications'), exact: true }));
        assert.ok(page.getByText(t(`accounts.notifications.${account.notifications.state}`), { exact: true }));
        assert.equal(page.queryByRole('list', { name: t('accounts.sessions'), exact: true }), null);
        assert.equal(page.queryByRole('button', { name: t('accounts.sendTest'), exact: true }), null);
      }
      const target = 'session_010000000000000000000004';
      sessions = [...sessions, { ...empty, target }];
      await act(async () => refreshAccounts());
      const mapped = accounts.get().items.find((account: any) => account.id === agent.id);
      assert.deepEqual(mapped.notifications.sessions.map((session: any) => session.target), [target]);
      assert.equal(mapped.notifications.sessions[0].registered, false);
      await render(notificationAccount(agent));
      const rows = within(page.getByRole('list', { name: t('accounts.sessions'), exact: true })).getAllByRole('listitem');
      assert.equal(rows.length, 1);
      assert.ok(within(rows[0]).getByText(target, { exact: true }));
      await act(async () => { fireEvent.click(within(rows[0]).getByRole('button', { name: t('accounts.sendTest'), exact: true })); });
      assert.equal((await get(agent.id)).notifications.sessions.find((session: any) => session.target === target).lastDelivery.status, 'sent');
    } finally { accountsApi.get = get; }
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
    const { default: AccountsPage } = await server.ssrLoadModule('/ui/components/AccountsPage.tsx');
    const { default: RemoteLinkPage } = await server.ssrLoadModule('/ui/components/RemoteLinkPage.tsx');
    const { default: SourcePanel } = await server.ssrLoadModule('/ui/components/SourcePanel.tsx');
    const { default: PlatformConnection } = await server.ssrLoadModule('/ui/components/PlatformConnection.tsx');
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
      await render(h(AccountsPage));
      assert.equal(page.queryByRole('button', { name: name => name.includes(legacy.alias) }), null);
      await render(null);
      navigation.set((old: any) => ({ ...old, remoteSourceId: local.id, remoteConnectionId: undefined }));
      await render(h(RemoteLinkPage));
      assert.equal(page.queryByRole('button', { name: name => name.includes(local.label) }), null);
      assert.ok(page.getByRole('button', { name: name => name.startsWith(external.label) && name.endsWith(t('source.state.connected')) }));
      assert.equal(page.queryByRole('button', { name: t('source.disconnect'), exact: true }), null);
      await render(h(SourcePanel, { source: local }));
      assert.equal(page.queryByRole('button', { name: t('source.disconnect'), exact: true }), null);
      await render(h(PlatformConnection, { ingress: { id: 'local-cli' }, onConnection() {} }));
      assert.equal(page.queryByRole('button', { name: t('edit'), exact: true }), null);
      const externalIngress = connector.get().status.ingresses.find((entry: any) => entry.id === external.ingressId);
      await render(h(PlatformConnection, { ingress: externalIngress, onConnection() {} }));
      assert.ok(page.getByRole('button', { name: t('edit'), exact: true }));
      await render(h(SourceProductChoice, { value: 'custom', onChange() {} }));
      const { controlSource } = await server.ssrLoadModule('/ui/controlSources.ts');
      await act(async () => { fireEvent.click(page.getByRole('combobox', { name: t('source.moreProducts'), exact: true })); });
      assert.ok(page.getByRole('option', { name: controlSource('chatgpt').shortName, exact: true }));
      assert.equal(page.queryByRole('option', { name: controlSource('local-cli').shortName, exact: true }), null);
      assert.equal(page.queryByRole('radio', { name: controlSource('local-cli').shortName, exact: true }), null);
    } finally { accountsApi.list = list; accountsApi.get = get; }
  });
});

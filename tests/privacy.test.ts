import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';
import { maskSensitive, sensitiveParts } from '../ui/privacyMask.ts';
import { buildClipboardText } from '../ui/privacyClipboard.ts';

test('mixed clipboard text replaces selected stand-ins by position', () => {
  // Regression: AX-26 copying a mixed selection discarded ordinary text and other sensitive values.
  const first = 'alex@example.com', second = 'Team 🦊';
  const maskedFirst = maskSensitive(first), maskedSecond = maskSensitive(second);
  const prefix = `Keep ${maskedFirst} / `, middle = ' belongs to ', suffix = ' today.';
  const text = prefix + maskedFirst + middle + maskedSecond + suffix;
  const secondStart = prefix.length + maskedFirst.length + middle.length;
  assert.equal(buildClipboardText(text, [
    { start: secondStart, end: secondStart + maskedSecond.length, value: second },
    { start: prefix.length, end: prefix.length + maskedFirst.length, value: first },
  ]), prefix + first + middle + second + suffix);
  assert.equal(buildClipboardText(text, []), text);
});

test('stand-ins are deterministic, preserve separators and replace every identity character', () => {
  // Property: masking preserves code-point length and separators while substituting every other character deterministically.
  for (const value of ['alex@example.com', 'Example Organization', 'provider:id:123', 'session_01', 'https://arc.example.com/mcp', '组织 🦊', 'I.W@X.io']) {
    for (const bullets of [false, true]) {
      const masked = maskSensitive(value, bullets);
      assert.equal(masked, maskSensitive(value, bullets));
      assert.equal(Array.from(masked).length, Array.from(value).length);
      Array.from(value).forEach((char, index) => {
        if (/[\s@.]/u.test(char)) assert.equal(Array.from(masked)[index], char);
        else assert.notEqual(Array.from(masked)[index], char);
      });
    }
  }
});

test('substring masking preserves prose and treats identities literally', () => {
  // Regression: whole-element blur hid surrounding information and left real identity substrings available.
  const values = ['Example (Team)', 'id:[key]', 'Example (Team) West'];
  const prose = 'Quota for Example (Team) West / alex@example.com / id:[key]: unavailable';
  const parts = sensitiveParts(prose, values);
  assert.equal(parts.map(part => part.text).join(''), prose);
  assert.deepEqual(parts.filter(part => part.sensitive).map(part => part.text), ['Example (Team) West', 'alex@example.com', 'id:[key]']);
  assert.equal(parts.filter(part => !part.sensitive).map(part => part.text).join(''), 'Quota for  /  / : unavailable');
  assert.deepEqual(sensitiveParts('Teamwork / Team / alex@example.com', ['Team', 'alex']).filter(part => part.sensitive).map(part => part.text), ['Team', 'alex@example.com']);
});

test('account privacy replaces DOM values, restores them exactly and preserves real copy actions', async () => {
  // Regression: AX-26 mixed selections lost ordinary text; hidden identities must also remain absent from the DOM.
  const window = new Window({ url: 'http://localhost/?scenario=accounts' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, location: window.location, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, Event: window.Event, DOMRect: window.DOMRect, CustomEvent: window.CustomEvent, CSS: window.CSS,
    localStorage: window.localStorage, ResizeObserver: Observer, matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    innerWidth: 1280, innerHeight: 800, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: window.navigator.userAgent, languages: window.navigator.languages, clipboard: { writeText: async (value: string) => { copied = value; } } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Privacy fixture contacted real Core'); };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('main'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('accounts');
    const { refreshAccounts, accounts } = await server.ssrLoadModule('/ui/state/accounts.ts');
    await refreshAccounts();
    const { setPrivacy, protectSnapshot } = await server.ssrLoadModule('/ui/state/privacy.ts');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { navigation } = await server.ssrLoadModule('/ui/state/navigation.ts');
    const { accountsApi } = await server.ssrLoadModule('/ui/api.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { default: PlatformsPage } = await server.ssrLoadModule('/ui/components/PlatformsPage.tsx');
    const { default: SourcePanel } = await server.ssrLoadModule('/ui/components/SourcePanel.tsx');
    const { default: SourcePlatformView } = await server.ssrLoadModule('/ui/components/SourcePlatformView.tsx');
    const { default: AgentPlatformView } = await server.ssrLoadModule('/ui/components/AgentPlatformView.tsx');
    const { default: ConnectionsContent } = await server.ssrLoadModule('/ui/components/ConnectionsContent.tsx');
    const { ActivityBubble } = await server.ssrLoadModule('/ui/components/ActivityBubbles.tsx');
    const { CopyField, Dialog, TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { Sensitive, SensitiveInput } = await server.ssrLoadModule('/ui/components/Sensitive.tsx');
    const { default: QuotaBubble } = await server.ssrLoadModule('/ui/subscriptions/QuotaBubble.tsx');
    const page = within(document.body), account = accounts.get().items.find((item: any) => item.id === 'account-claude');
    const sourceAccount = accounts.get().items.find((item: any) => item.id === 'account-openai');
    const source = connector.get().sources.find((item: any) => sourceAccount.sources.includes(item.id));
    navigation.set((old: any) => ({ ...old, platformId: 'openai' }));
    const address = connector.get().status.ingresses.find((item: any) => item.id === source.ingressId).url;
    const raw = accounts.get().items.flatMap((item: any) => [item.email, item.orgName, item.identityKey, ...item.notifications.sessions.map((session: any) => session.target)]).filter(Boolean).concat(connector.get().status.ingresses.map((item: any) => item.url).filter(Boolean));
    // Inspect content and attributes together: a hidden raw mirror is still a leak.
    const assertPrivate = () => { for (const value of raw) assert.ok(!document.documentElement.outerHTML.includes(value), `DOM leaked ${value}`); };
    const render = async (child: any) => { await act(async () => root.render(h(TooltipProvider, null, child))); };
    // Selected stand-ins copy their original value, including within mixed selections.
    await act(async () => setPrivacy(true));
    await render(h(Sensitive, null, account.email));
    const masked = page.getByLabelText(t('accounts.hidden'), { exact: true });
    const selection = window.getSelection()!;
    selection.selectAllChildren(masked);
    assert.equal(selection.toString(), maskSensitive(account.email));
    assertPrivate();
    const clipboard = new window.DataTransfer();
    clipboard.setData('text/plain', selection.toString());
    assert.equal(fireEvent.copy(masked, { clipboardData: clipboard }), false);
    assert.equal(clipboard.getData('text/plain'), account.email);
    assert.notEqual(clipboard.getData('text/plain'), selection.toString());
    selection.removeAllRanges();
    await render(h('section', { role: 'group', 'aria-label': 'Copy selection' }, 'Account: ', h(Sensitive, null, account.email), ' / ', h(Sensitive, null, account.orgName), ' selected.'));
    const group = page.getByRole('group', { name: 'Copy selection' });
    selection.selectAllChildren(group);
    assertPrivate();
    assert.equal(fireEvent.copy(group, { clipboardData: clipboard }), false);
    assert.equal(clipboard.getData('text/plain'), `Account: ${account.email} / ${account.orgName} selected.`);
    selection.selectAllChildren(page.getAllByLabelText(t('accounts.hidden'), { exact: true })[1]);
    assert.equal(fireEvent.copy(group, { clipboardData: clipboard }), false);
    assert.equal(clipboard.getData('text/plain'), account.orgName);
    selection.removeAllRanges();
    await render(h(Sensitive, null, account.email));
    await act(async () => setPrivacy(false));
    assert.ok(page.getByText(account.email, { exact: true }));
    assert.equal(fireEvent.copy(page.getByText(account.email, { exact: true }), { clipboardData: clipboard }), true);
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      await act(async () => setPrivacy(true));
      await render(h(PlatformsPage)); assertPrivate();
      await act(async () => { fireEvent.click(page.getByRole('button', { name: t('platforms.rename', { name: source.label }), exact: true })); });
      assert.ok(page.getByRole('textbox', { name: t('platforms.name'), exact: true }));
      assertPrivate();
      await act(async () => { fireEvent.click(page.getByRole('button', { name: t('cancel'), exact: true })); });
      await act(async () => setPrivacy(false));
      assert.equal(page.queryByText(account.email, { exact: true }), null);
      assert.equal(page.queryByText(account.orgName, { exact: true }), null);
    }
    await act(async () => setPrivacy(true));
    await render(h(Dialog, { title: 'Source', onClose() {} }, h(SourcePanel, { source })));
    assertPrivate();
    await render(h(Dialog, { title: 'Source platform', onClose() {} }, h(SourcePlatformView, { platform: source.product })));
    assertPrivate();
    await act(async () => setPrivacy(false));
    assert.ok(page.getByText(source.authorizationFacts.email, { exact: true }));
    assert.ok(page.getByText(source.authorizationFacts.orgName, { exact: true }));
    assert.equal(page.queryByText(sourceAccount.identityKey, { exact: true }), null);
    await act(async () => setPrivacy(true));
    await render(h(Dialog, { title: 'Agent platform', onClose() {} }, h(AgentPlatformView, { agent: { agent: 'codex' } })));
    assertPrivate();
    await act(async () => setPrivacy(false));
    assert.ok(page.getByText(sourceAccount.email, { exact: true }));
    assert.equal(page.queryByText(sourceAccount.orgName, { exact: true }), null);
    assert.equal(page.queryByText(sourceAccount.identityKey, { exact: true }), null);
    await act(async () => setPrivacy(true));
    await act(async () => navigation.set((old: any) => ({ ...old, remoteSourceId: undefined, remoteConnectionId: undefined })));
    await render(h(ConnectionsContent)); assertPrivate();
    await render(h(CopyField, { value: address, label: 'Connection address' })); assertPrivate();
    await act(async () => { fireEvent.click(page.getByRole('button', { name: t('copy'), exact: true })); });
    assert.equal(copied, address);
    await act(async () => setPrivacy(false));
    assert.ok(page.getByText(address, { exact: true }));
    await act(async () => protectSnapshot()); assertPrivate();
    await render(h(SensitiveInput, { value: account.notifications.sessions[0].target, 'aria-label': 'Session', onChange() {} }));
    const input = page.getByRole('textbox', { name: 'Session', exact: true }) as HTMLInputElement;
    assert.notEqual(input.value, account.notifications.sessions[0].target); assert.equal(input.readOnly, true);
    clipboard.setData('text/plain', input.value);
    input.select();
    assert.equal(fireEvent.copy(input, { clipboardData: clipboard }), false);
    assert.equal(clipboard.getData('text/plain'), account.notifications.sessions[0].target);
    input.setSelectionRange(0, 7);
    assert.equal(fireEvent.copy(input, { clipboardData: clipboard }), false);
    assert.equal(clipboard.getData('text/plain'), account.notifications.sessions[0].target.slice(0, 7));
    assertPrivate();
    await act(async () => setPrivacy(false));
    assert.equal(input.value, account.notifications.sessions[0].target); assert.equal(input.readOnly, false);
    await act(async () => setPrivacy(true));
    await render(h(ActivityBubble, { agent: 'codex', session: { id: 'privacy-task', title: 'Ship the account screen', headline: '', source: 'arc-task', phase: 'idle', phaseSince: null, orderAt: 1 }, now: 1, onRead() {} }));
    assert.ok(page.getByRole('button', { name: name => name.startsWith('Ship the account screen') }));
    assert.ok(page.getAllByText('Ship the account screen', { exact: true }).length > 0);
    const message = `Quota for ${account.orgName} (${account.email}) unavailable`;
    await render(h(QuotaBubble, { provider: { providerId: 'example', agentId: 'claude', agentIds: ['claude'], name: 'Claude', eligible: true, state: 'ready', blockedPoolIds: [], windows: [], error: { code: 'failed', message } }, link: false }));
    assertPrivate();
    const warning = page.getByRole('img', { name: name => name.startsWith('Quota for ') });
    await act(async () => warning.focus());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    assert.ok(page.getByRole('dialog')); assertPrivate();
    await act(async () => setPrivacy(false));
    assert.ok(page.getByRole('img', { name: message, exact: true }));
    assert.equal((await accountsApi.get(account.id)).email, account.email);
  } finally {
    await act(async () => root.unmount());
    await server.close(); globalThis.fetch = originalFetch; await window.happyDOM.abort();
  }
});

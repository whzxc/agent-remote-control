import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

test('a downloaded update restarts directly from its button', { timeout: 10000 }, async () => {
  // Regression: a downloaded update entered task settling and a countdown instead of installing when clicked.
  const previousFetch = globalThis.fetch;
  const window = new Window({ url: 'http://localhost' });
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement, CustomEvent: window.CustomEvent, Event: window.Event,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, CSS: window.CSS,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: Observer, matchMedia: () => media, innerWidth: 840, innerHeight: 578,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: clearTimeout,
  });
  window.matchMedia = () => media as unknown as MediaQueryList;
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount);
  const root = createRoot(mount);
  let response: Record<string, any> | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/updates/install') response = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ restarting: true }), { status: 200 });
  };
  try {
    const { UpdateDock, AppUpdate } = await server.ssrLoadModule('/ui/components/AppUpdate.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { updates, acceptUpdateSnapshot } = await server.ssrLoadModule('/ui/state/updates.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { idleUpdate } = await server.ssrLoadModule('/ui/state/updateModel.ts');
    await act(async () => {
      acceptUpdateSnapshot({ ...idleUpdate(), update: { available: true, version: '1.2.3', ready: true } });
      root.render(h(TooltipProvider, null, h(UpdateDock)));
    });
    const page = within(document.body);
    assert.equal(page.queryByRole('dialog'), null);
    const trigger = page.getByRole('button', { name: t('viewUpdate') });
    trigger.focus();
    await act(async () => { fireEvent.click(trigger); });
    assert.ok(page.getByRole('dialog', { name: t('appUpdates') }));
    const panel = within(page.getByRole('dialog', { name: t('appUpdates') }));
    await act(async () => { fireEvent.click(panel.getByRole('button', { name: t('updates.restartNow') })); });
    assert.deepEqual(response, { version: '1.2.3' });
    assert.equal(updates.get().snapshot.phase, 'installing');
    assert.equal(panel.queryByRole('button', { name: t('updates.restartNow') }), null);
    assert.ok(panel.getByRole('status'));
    await act(async () => { updates.set((old: any) => ({ ...old, panelOpen: false })); });
    assert.equal(page.queryByRole('dialog'), null);
    await act(async () => {
      updates.set((old: any) => ({ ...old, snapshot: idleUpdate(), error: '', message: '' }));
      root.render(h(TooltipProvider, null, h(AppUpdate)));
    });
    assert.ok(page.getByRole('heading', { name: t('aboutApp'), exact: true }));
    assert.ok(page.getByRole('button', { name: t('checkForUpdates'), exact: true }));
    assert.ok(page.getByRole('button', { name: 'GitHub', exact: true }));
    assert.equal(page.queryByRole('switch'), null);
    await act(async () => acceptUpdateSnapshot({ ...idleUpdate(), update: { available: true, version: '1.2.4', ready: true } }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('viewUpdate'), exact: true })));
    assert.equal(updates.get().panelOpen, true);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await window.happyDOM.close();
    globalThis.fetch = previousFetch;
  }
});

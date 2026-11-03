import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h, useLayoutEffect, useRef } from 'react';
import { within, fireEvent } from '@testing-library/dom';

test('Board update attention opens a focused update panel and Escape returns to its row', { timeout: 10000 }, async () => {
  // Regression: coordination-problems dismissed App updates during the Board focus handoff at 1280x800.
  const window = new Window({ url: 'http://localhost/?scenario=coordination-problems' });
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  Object.assign(globalThis, {
    window, document: window.document, location: window.location, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, NodeList: window.NodeList, NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    CustomEvent: window.CustomEvent, Event: window.Event, MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, CSS: window.CSS,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: Observer,
    matchMedia: window.matchMedia, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Fixture contacted a real service'); };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('main'); document.body.append(mount); const root = createRoot(mount);
  // Drain Radix's deferred unmount autofocus and the application's next focus frame.
  const settle = async () => {
    for (let turn = 0; turn < 3; turn++) await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  };
  try {
    const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('coordination-problems');
    const { updates } = await server.ssrLoadModule('/ui/state/updates.ts');
    updates.set((old: any) => ({ ...old, phase: 'idle', checked: true, error: 'Synthetic update failure', panelOpen: false }));
    const { default: Board, centerReturn } = await server.ssrLoadModule('/ui/coordination/CoordinationCenter.tsx');
    const { boardOpen, boardFocus, openCenter } = await server.ssrLoadModule('/ui/coordination/state.ts');
    const { UpdateDock } = await server.ssrLoadModule('/ui/components/AppUpdate.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Harness() {
      const open = boardOpen.use(), returning = centerReturn.use(), updateOpen = updates.use().panelOpen;
      const ownerOpened = useRef(false);
      useLayoutEffect(() => {
        if (!returning) { ownerOpened.current = false; return; }
        if (updateOpen) { ownerOpened.current = true; return; }
        if (ownerOpened.current) {
          centerReturn.set(undefined); boardFocus.set(returning.focusId); boardOpen.set(true);
        }
      }, [returning, updateOpen]);
      return h('div', null, h('button', { id: 'board-trigger', onClick: openCenter }, t('center.open')),
        h(UpdateDock), open && h(Board));
    }
    await act(async () => root.render(h(TooltipProvider, null, h(Harness))));
    await settle();
    const page = within(document.body);
    const trigger = page.getByRole('button', { name: t('center.open'), exact: true });
    await act(async () => { trigger.focus(); fireEvent.click(trigger); });
    await settle();
    const board = within(page.getByRole('dialog', { name: t('center.title'), exact: true }));
    const linkName = new RegExp(`${t('center.update')}$`);
    const link = within(board.getByRole('region', { name: t('center.attention'), exact: true })).getByRole('button', { name: linkName });
    await act(async () => { link.focus(); fireEvent.click(link); });
    await settle();
    assert.equal(page.queryByRole('dialog', { name: t('center.title'), exact: true }), null);
    const owner = page.getByRole('dialog', { name: t('appUpdates'), exact: true });
    const close = within(owner).getByRole('button', { name: t('close'), exact: true });
    assert.ok(close.matches(':focus'));
    await act(async () => { fireEvent.keyDown(close, { key: 'Escape' }); });
    await settle();
    assert.equal(page.queryByRole('dialog', { name: t('appUpdates'), exact: true }), null);
    const returned = within(page.getByRole('dialog', { name: t('center.title'), exact: true }));
    assert.ok(within(returned.getByRole('region', { name: t('center.attention'), exact: true })).getByRole('button', { name: linkName }).matches(':focus'));
  } finally {
    await act(async () => root.unmount());
    await server.close(); await window.happyDOM.close(); globalThis.fetch = previousFetch;
  }
});

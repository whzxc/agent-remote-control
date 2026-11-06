import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h, useState } from 'react';
import { within, fireEvent } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';

test('nested setup exposes only the active dialog and restores its parent on close', async () => {
  // Regression: p3-stacked setup mounted both modal portals together and the parent hid the focused child from assistive technology.
  const window = new Window({ url: 'http://localhost' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter,
    HTMLInputElement: window.HTMLInputElement, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect,
    innerWidth: 1280, innerHeight: 800, ResizeObserver: Observer, matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true,
  });
  let focused: Node | null = null;
  document.addEventListener('focusin', event => { focused = event.target as Node; });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { default: SetupDialog } = await server.ssrLoadModule('/ui/components/SetupDialog.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Setup() {
      const [child, setChild] = useState(true);
      return h('main', null,
        h('button', null, 'Background action'),
        h(SetupDialog, { title: 'Parent setup', active: 0, steps: [], onClose() {} },
          h('input', { 'aria-label': 'Source name', defaultValue: 'Saved source' }),
          h('button', { onClick: () => setChild(true) }, 'Add connection')),
        child && h(SetupDialog, { title: 'Child connection', parentTitle: 'Parent setup', stacked: true, active: 0,
          steps: [], onClose: () => setChild(false) },
          h('input', { 'aria-label': 'Connection address' })));
    }
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const page = within(document.body);
    await act(async () => root.render(h(Setup))); await settle();
    for (let opening = 0; opening < 2; opening++) {
      const child = page.getByRole('dialog', { name: 'Child connection' });
      assert.equal(page.getAllByRole('dialog').length, 1);
      assert.equal(page.queryByRole('button', { name: 'Background action' }), null);
      assert.equal(page.queryByRole('textbox', { name: 'Source name' }), null);
      assertNodeIdentity(focused, child);
      await act(async () => fireEvent.click(within(child).getByRole('button', { name: t('close') })));
      await settle();
      const parent = page.getByRole('dialog', { name: 'Parent setup' });
      assert.equal(page.getAllByRole('dialog').length, 1);
      assertNodeIdentity(focused, opening ? within(parent).getByRole('button', { name: 'Add connection' }) : parent);
      assert.equal((page.getByRole('textbox', { name: 'Source name' }) as HTMLInputElement).value, 'Saved source');
      if (!opening) {
        const trigger = within(parent).getByRole('button', { name: 'Add connection' });
        await act(async () => { trigger.focus(); fireEvent.click(trigger); }); await settle();
      }
    }
  } finally {
    await act(async () => root.unmount()); await server.close(); await window.happyDOM.close();
  }
});

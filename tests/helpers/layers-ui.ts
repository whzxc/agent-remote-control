import {Window} from 'happy-dom';
import {createServer,type ViteDevServer} from 'vite';
import {act} from 'react';
import type {Root} from 'react-dom/client';

export async function withDialog(run: (context: { server: ViteDevServer; root: Root; settle: () => Promise<void>; focused: () => Node | null }) => Promise<void>) {
  const window = new Window({ url: 'http://localhost/?scenario=p3-stacked-secure-en@light' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, location: window.location, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
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
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try { await run({ server, root, settle, focused: () => focused }); }
  finally { await act(async () => root.unmount()); await server.close(); await window.happyDOM.close(); }
}

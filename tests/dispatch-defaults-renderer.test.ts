import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

test('Agent and task defaults retain pending edits across consecutive changes and settings remounts', { timeout: 10000 }, async () => {
  // Regression: PR #15 lost models on consecutive edits, including closing and reopening settings before a save returned.
  const originalFetch = globalThis.fetch;
  const window = new Window({ url: 'http://localhost' });
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    NodeFilter: window.NodeFilter, DocumentFragment: window.DocumentFragment, HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement, CustomEvent: window.CustomEvent, Event: window.Event,
    MutationObserver: window.MutationObserver, DOMRect: window.DOMRect, CSS: window.CSS,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: Observer, matchMedia: () => media, innerWidth: 1280, innerHeight: 800,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: clearTimeout,
  });
  window.matchMedia = () => media as unknown as MediaQueryList;
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount);
  const root = createRoot(mount);
  type Defaults = { model: string | null; effort: string | null };
  let saved: Defaults = { model: null, effort: null };
  const pending: Array<{ body: Defaults; finish: (fail?: boolean) => void }> = [];
  globalThis.fetch = async (url, init) => {
    const route = String(url);
    if (route.endsWith('/dispatch-catalog')) return new Response(JSON.stringify({ models: [
      { model: 'fixture-model', displayName: 'Fixture model', efforts: ['low', 'high'] },
    ] }));
    if (route.endsWith('/dispatch-defaults/read')) return new Response(JSON.stringify(saved));
    if (route.endsWith('/dispatch-defaults')) {
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>(resolve => pending.push({ body, finish: fail => {
        if (fail) resolve(new Response(JSON.stringify({ error: 'Fixture save failure' }), { status: 500 }));
        else { saved = { model: body.model, effort: body.effort }; resolve(new Response(JSON.stringify(saved))); }
      } }));
    }
    return new Response('{}');
  };
  try {
    const { default: AgentDefaults, TaskSpecChoice } = await server.ssrLoadModule('/ui/components/AgentDispatchDefaults.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const page = within(document.body);
    const click = async (element: HTMLElement) => act(async () => { fireEvent.click(element); });
    const openTask = async () => {
      await click(page.getByRole('button', { name: t('taskDispatch.title') }));
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    };
    const modelButton = () => page.getByRole('button', { name: new RegExp(`^${t('dispatchDefaults.model')}:`) });
    for (const [entry, reopen] of [['agent', false], ['task', false], ['agent', true], ['task', true]] as const) {
      saved = { model: null, effort: null }; pending.length = 0;
      const render = () => root.render(h(TooltipProvider, null, entry === 'agent'
        ? h(AgentDefaults, { agent: 'codex' })
        : h(TaskSpecChoice, { agent: 'codex', threadId: '00000000-0000-4000-8000-000000000001', editable: true })));
      await act(async () => render());
      if (entry === 'task') await openTask();
      await click(page.getByRole('button', { name: t('dispatchDefaults.spec') }));
      await act(async () => { fireEvent.keyDown(modelButton(), { key: 'Enter' }); });
      await click(page.getByRole('menuitemradio', { name: 'Fixture model' }));
      if (reopen) {
        await act(async () => root.render(null));
        await act(async () => render());
        if (entry === 'task') await openTask();
        await click(page.getByRole('button', { name: t('dispatchDefaults.spec') }));
      }
      const slider = page.getByRole('slider', { name: t('dispatchDefaults.effort') });
      await act(async () => { fireEvent.keyDown(slider, { key: 'End' }); });
      // Complete the first save only after the second user edit.
      await act(async () => { pending.shift()!.finish(); });
      await act(async () => { pending.shift()!.finish(); });
      assert.deepEqual(saved, { model: 'fixture-model', effort: 'high' }, entry);
      assert.equal(modelButton().getAttribute('aria-label'), `${t('dispatchDefaults.model')}: Fixture model`);
      assert.equal(slider.getAttribute('aria-valuetext'), t('dispatchSpec.effort.high'));
      // A failed later edit restores the last acknowledged pair, then remains editable.
      await act(async () => { fireEvent.keyDown(slider, { key: 'Home' }); });
      await act(async () => { pending.shift()!.finish(true); });
      assert.deepEqual(saved, { model: 'fixture-model', effort: 'high' }, entry);
      assert.equal(slider.getAttribute('aria-valuetext'), t('dispatchSpec.effort.high'));
      await act(async () => { fireEvent.keyDown(slider, { key: 'Home' }); });
      await act(async () => { pending.shift()!.finish(); });
      assert.deepEqual(saved, { model: 'fixture-model', effort: null }, entry);
      await act(async () => root.render(null));
      // Reopening reads the persisted pair rather than relying on optimistic UI state.
      await act(async () => render());
      if (entry === 'task') await openTask();
      assert.ok(page.getByRole('button', { name: t('dispatchDefaults.spec') }).textContent?.includes('Fixture model'));
      await act(async () => root.render(null));
    }
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await server.close(); await window.happyDOM.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h, useRef } from 'react';
import { within, fireEvent } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';

async function withTopology(run: (context: any) => Promise<void>) {
  const previousFetch = globalThis.fetch, window = new Window({ url: 'http://localhost' });
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
  class Observer { observe() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    CustomEvent: window.CustomEvent, ResizeObserver: Observer, devicePixelRatio: 1,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280, innerHeight: 800, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { appEnvironment } = await server.ssrLoadModule('/ui/state/appEnvironment.ts');
    const { topologyLayout } = await server.ssrLoadModule('/ui/subscriptions/displayPreferences.ts');
    const { viewModel } = await server.ssrLoadModule('/ui/acceptance.ts');
    const settle = async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
      await act(async () => {
        for (let i = 0; frames.size && i < 10; i++) {
          const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now()));
        }
      });
    };
    const dimensions = (width: number, height: number) => {
      const now = Date.now();
      appEnvironment.set({ active: true, expiresAt: now + 60_000, realNowMs: now, overrides: { windowWidth: width, windowHeight: height, reducedMotion: true }, clock: { value: { nowMs: now, speed: 1 }, source: 'system' } });
    };
    await run({ Topology, appEnvironment, topologyLayout, viewModel, root, mount, settle, dimensions });
  } finally {
    await act(async () => root.unmount()); await server.close(); await window.happyDOM.abort();
    globalThis.fetch = previousFetch;
  }
}

test('environment dimensions drive the mounted topology after settling and defer while dragging', async () => {
  // Regression: app_env width-only input could not drive portrait geometry or expose effective orientation in the live snapshot.
  await withTopology(async ({ Topology, topologyLayout, viewModel, root, mount, settle, dimensions }) => {
    const source = { id: 'source', label: 'Example source', state: 'normal', attention: false, selected: false, reorderable: true, tasks: [], content: h('button', null, 'Example source') };
    function Harness() {
      const boundary = useRef<HTMLElement>(null), handle = useRef(null);
      return h('section', { ref: boundary }, h(Topology, { left: [source], right: [], brand: h('span', null, 'ARC'),
        boundary, ref: handle, onReorderNodes() {}, onReorderTasks() {} }));
    }
    await act(async () => root.render(h(Harness))); await settle();
    const button = within(mount).getByRole('button', { name: 'Example source' });
    assert.equal(viewModel().topology.orientation, 'landscape');
    await act(async () => fireEvent.pointerDown(button, { pointerId: 1, button: 0, isPrimary: true, clientX: 100, clientY: 100 }));
    await act(async () => dimensions(600, 1000)); await settle();
    assert.equal(viewModel().topology.orientation, 'landscape');
    assert.equal(viewModel().topology.orientationPending, true);
    await act(async () => fireEvent.pointerUp(button, { pointerId: 1, button: 0, isPrimary: true })); await settle();
    assert.equal(viewModel().topology.orientation, 'portrait');
    assert.equal(viewModel().topology.source, 'auto');
    assertNodeIdentity(within(mount).getByRole('button', { name: 'Example source' }), button);
    await act(async () => dimensions(900, 1000)); await settle();
    assert.equal(viewModel().topology.orientation, 'portrait');
    await act(async () => topologyLayout.set('landscape')); await settle();
    assert.equal(viewModel().topology.orientation, 'landscape');
    assert.equal(viewModel().topology.source, 'manual');
    assert.equal(localStorage.getItem('topology-layout'), 'landscape');
  });
});

test('task queues leave accessible navigation while their Agent panel is open and return after closing', async () => {
  // Regression: task-relationships-detail exposed transparent queue buttons behind the task-final card.
  await withTopology(async ({ Topology, topologyLayout, root, mount, settle }) => {
    const title = 'Related task';
    const task = { id: 'related', parentTaskId: 'parent', width: 264, height: 54, state: 'done',
      content: h('button', null, title) };
    const agent = { id: 'agent', state: 'normal', attention: false, tasks: [task], content: h('button', null, 'Agent') };
    function Harness({ selected }: { selected: boolean }) {
      const boundary = useRef<HTMLElement>(null);
      return h('section', { ref: boundary }, h(Topology, { left: [], right: [{ ...agent, selected }],
        brand: h('span', null, 'ARC'), boundary, panelKey: selected ? 'agent:example' : undefined,
        onReorderNodes() {}, onReorderTasks() {} }));
    }
    for (const orientation of ['landscape', 'portrait']) {
      await act(async () => { topologyLayout.set(orientation); root.render(h(Harness, { selected: false })); });
      await settle();
      assert.ok(within(mount).getByRole('button', { name: title }));
      await act(async () => root.render(h(Harness, { selected: true }))); await settle();
      assert.equal(within(mount).queryByRole('button', { name: title }), null);
      await act(async () => root.render(h(Harness, { selected: false }))); await settle();
      assert.ok(within(mount).getByRole('button', { name: title }));
    }
  });
});

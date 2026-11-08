import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h, useRef, useState } from 'react';
import { within, fireEvent } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';

async function withTopology(run: (context: any) => Promise<void>) {
  const previousFetch = globalThis.fetch, window = new Window({ url: 'http://localhost' });
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
  class Observer { observe() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    CustomEvent: window.CustomEvent, MutationObserver: window.MutationObserver, NodeFilter: window.NodeFilter,
    Event: window.Event, HTMLInputElement: window.HTMLInputElement, getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: Observer, devicePixelRatio: 1,
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
  const { Dialog: D, Popover: P } = await import('radix-ui');
  const mount = document.createElement('div'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { appEnvironment } = await server.ssrLoadModule('/ui/state/appEnvironment.ts');
    const { topologyLayout } = await server.ssrLoadModule('/ui/subscriptions/displayPreferences.ts');
    const { viewModel } = await server.ssrLoadModule('/ui/acceptance.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const flushFrames = () => act(async () => {
      for (let i = 0; frames.size && i < 10; i++) {
        const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now()));
      }
    });
    const settle = async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
      await flushFrames();
    };
    const dimensions = (width: number, height: number) => {
      const now = Date.now();
      appEnvironment.set({ active: true, expiresAt: now + 60_000, realNowMs: now, overrides: { windowWidth: width, windowHeight: height, reducedMotion: true }, clock: { value: { nowMs: now, speed: 1 }, source: 'system' } });
    };
    await run({ Topology, D, P, appEnvironment, topologyLayout, viewModel, t, root, mount, settle, flushFrames, dimensions });
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

test('activated groups persist through activity refresh and fold on outside input or Escape', async () => {
  // Regression: automatic unfolding shifted the dense scene, and task refresh could replace an explicitly opened group's membership.
  await withTopology(async ({ Topology, topologyLayout, viewModel, t, root, mount, settle, flushFrames }) => {
    function Harness({ active = false }) {
      const boundary = useRef<HTMLElement>(null);
      const children = Array.from({ length: 11 }, (_, i) => ({ id: `account-${i}`, platform: 'codex', state: 'normal', attention: false, selected: false,
        tasks: i < 3 || active && i === 3 ? Array.from({ length: i === 0 ? 2 : 1 }, (_, j) => ({ id: `work-${i}-${j}`, width: 264, height: 76, state: 'running', content: h('button', null, `Work ${i}-${j}`) })) : [],
        content: h('button', { type: 'button' }, `Account ${i}`) }));
      const right = [{ id: 'codex', state: 'normal', attention: false, selected: false, tasks: [], children, content: h('button', null, 'Codex') },
        ...['claude', 'opencode', 'dsh', 'cursor'].map(id => ({ id, state: 'normal', attention: false, selected: false, tasks: [], content: h('button', null, id) }))];
      return h('section', { ref: boundary }, h(Topology, { left: [], right, brand: h('button', null, 'Outside'), boundary, onReorderNodes() {}, onReorderTasks() {} }));
    }
    await act(async () => { topologyLayout.set('landscape'); root.render(h(Harness)); }); await settle();
    const accountGroup = () => viewModel().topology.groups.find((g: any) => g.parent === 'codex');
    const capsule = within(mount).getByRole('button', { name: `${t('topology.idleAccounts', { count: 8 })} · ${t('topology.expand')}` });
    await act(async () => { capsule.focus(); fireEvent.pointerDown(capsule, { pointerType: 'touch' }); fireEvent.click(capsule); }); await flushFrames();
    const first = within(mount).getByRole('button', { name: 'Account 3', exact: true });
    assert.ok(first.matches(':focus'));
    const members = accountGroup().members;
    await act(async () => root.render(h(Harness, { active: true }))); await settle();
    assert.equal(accountGroup().folded, false);
    assert.deepEqual(accountGroup().members, members);
    await act(async () => fireEvent.pointerDown(first)); await flushFrames();
    assert.equal(accountGroup().folded, false);
    await act(async () => fireEvent.pointerDown(within(mount).getByLabelText('account-3 connection'))); await flushFrames();
    assert.equal(accountGroup().folded, false);
    await act(async () => fireEvent.keyDown(first, { key: 'Escape' })); await flushFrames();
    assert.equal(accountGroup().folded, true);
    assert.ok(capsule.matches(':focus'));
    await act(async () => fireEvent.click(capsule)); await flushFrames();
    const rootCapsule = within(mount).getByRole('button', { name: `${t('topology.idleAgents', { count: 4 })} · ${t('topology.expand')}` });
    await act(async () => { fireEvent.pointerDown(rootCapsule); fireEvent.click(rootCapsule); }); await flushFrames();
    assert.equal(accountGroup().folded, true);
    assert.equal(viewModel().topology.groups.find((g: any) => !g.parent && g.side === 1).folded, false);
    const outside = within(mount).getByRole('button', { name: 'Outside', exact: true });
    await act(async () => { outside.focus(); fireEvent.pointerDown(outside); }); await flushFrames();
    assert.ok(viewModel().topology.groups.every((g: any) => g.folded));
    assert.ok(outside.matches(':focus'));
  });
});

test('member portals and panels are inside the group and consume Escape first', async () => {
  // Regression: DOM-only outside checks dismissed topology groups when users interacted with a member's portaled layers.
  await withTopology(async ({ Topology, D, P, topologyLayout, viewModel, t, root, mount, settle, flushFrames }) => {
    function Harness() {
      const boundary = useRef<HTMLElement>(null), handle = useRef<any>(null);
      const [panel, setPanel] = useState(false);
      const children = Array.from({ length: 8 }, (_, i) => ({ id: `member-${i}`, platform: 'codex', state: 'normal', attention: false, selected: panel && i === 0, tasks: [],
        content: i ? h('button', null, `Member ${i}`) : h('div', null,
          h('button', { onClick: () => setPanel(true) }, 'Member 0'),
          h(P.Root, null, h(P.Trigger, null, 'Member options'), h(P.Portal, null, h(P.Content, { 'aria-label': 'Member options' }, h('button', null, 'Portal action'))))) }));
      const right = [{ id: 'codex', state: 'normal', attention: false, selected: false,
        tasks: [{ id: 'busy', state: 'running', width: 264, height: 400, content: h('button', null, 'Busy work') }], children, content: h('button', null, 'Codex') }];
      return h('section', { ref: boundary, onPointerDownCapture: (event: any) => {
        if (!event.currentTarget.contains(event.target)) handle.current?.memberLayerPointer(event.nativeEvent);
      } }, h(Topology, { left: [], right, boundary, ref: handle, panelKey: panel ? 'agent:member-0' : undefined,
        brand: h('span', null, 'ARC'), onReorderNodes() {}, onReorderTasks() {} }),
        h(D.Root, { open: panel, onOpenChange: setPanel }, h(D.Portal, null, h(D.Content, { 'aria-describedby': undefined }, h(D.Title, null, 'Member panel'), h('button', null, 'Panel action')))));
    }
    await act(async () => { topologyLayout.set('landscape'); root.render(h(Harness)); }); await settle();
    const capsule = within(mount).getByRole('button', { name: `${t('topology.idleAccounts', { count: 8 })} · ${t('topology.expand')}` });
    await act(async () => fireEvent.click(capsule)); await flushFrames();
    await act(async () => fireEvent.click(within(mount).getByRole('button', { name: 'Member options', exact: true }))); await flushFrames();
    const portalAction = within(document.body).getByRole('button', { name: 'Portal action', exact: true });
    await act(async () => fireEvent.pointerDown(portalAction)); await flushFrames();
    assert.equal(viewModel().topology.groups[0].folded, false);
    await act(async () => fireEvent.keyDown(portalAction, { key: 'Escape' })); await flushFrames();
    assert.equal(viewModel().topology.groups[0].folded, false);
    await act(async () => fireEvent.click(within(mount).getByRole('button', { name: 'Member 0', exact: true }))); await settle();
    const panelAction = within(document.body).getByRole('button', { name: 'Panel action', exact: true });
    await act(async () => fireEvent.pointerDown(panelAction)); await flushFrames();
    assert.equal(viewModel().topology.groups[0].folded, false);
    await act(async () => fireEvent.keyDown(panelAction, { key: 'Escape' })); await flushFrames();
    assert.equal(within(document.body).queryByRole('dialog', { name: 'Member panel' }), null);
    assert.equal(viewModel().topology.groups[0].folded, false);
    await act(async () => fireEvent.keyDown(within(mount).getByRole('button', { name: 'Member 0', exact: true }), { key: 'Escape' })); await flushFrames();
    assert.equal(viewModel().topology.groups[0].folded, true);
    assert.ok(capsule.matches(':focus'));
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

test('update reminder opens on request and answers blocking questions through the existing responder', { timeout: 10000 }, async () => {
  // Regression: update dialogs interrupted background work and offered no way to answer their blockers inline.
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
    if (String(url) === '/api/agents/respond') response = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ requestId: response?.args.requestId, state: 'completed' }), { status: 200 });
  };
  try {
    const { UpdateDock, AppUpdate } = await server.ssrLoadModule('/ui/components/AppUpdate.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { updates, acceptUpdateSnapshot } = await server.ssrLoadModule('/ui/state/updates.ts');
    const { agentActivity } = await server.ssrLoadModule('/ui/state/activity.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { idleUpdate } = await server.ssrLoadModule('/ui/state/updateModel.ts');
    await act(async () => {
      acceptUpdateSnapshot({ ...idleUpdate(), state: 'available', source: { kind: 'release', version: '1.2.3' } });
      root.render(h(TooltipProvider, null, h(UpdateDock)));
    });
    const page = within(document.body);
    assert.equal(page.queryByRole('dialog'), null);
    const trigger = page.getByRole('button', { name: t('viewUpdate') });
    trigger.focus();
    await act(async () => { fireEvent.click(trigger); });
    assert.ok(page.getByRole('dialog', { name: t('appUpdates') }));
    await act(async () => {
      agentActivity.set({ error: '', snapshot: { activeAgents: ['codex'], observedAt: new Date().toISOString(), agents: { codex: { sessions: [{ id: 'task', source: 'codex-thread', phase: 'interaction', headline: 'Question', phaseSince: null, timeline: true,
        interaction: { kind: 'question', method: 'item/tool/requestUserInput', summary: 'Target', questions: [{ id: 'target', question: 'Target', options: [] }], canRespond: true, respond: { op: 'codex_respond', args: { id: 'question', backendSession: 'fixture' } } } }] } } } });
      acceptUpdateSnapshot({ ...idleUpdate(), id: 'job', state: 'settling', canSchedule: true, source: { kind: 'local', version: '1.2.3' }, work: { blocking: [{ kind: 'turn', agent: 'codex', taskId: 'task', question: {} }], willResume: [], unaffected: [] } });
    });
    const panel = within(page.getByRole('dialog', { name: t('appUpdates') }));
    assert.ok(panel.getByRole('region', { name: t('updates.blocking') }));
    await act(async () => { fireEvent.change(panel.getByRole('textbox', { name: t('timeline.answer') }), { target: { value: 'staging' } }); });
    await act(async () => { fireEvent.click(panel.getByRole('button', { name: t('detail.sendAnswer') })); });
    assert.equal(response?.op, 'codex_respond');
    assert.deepEqual(response?.args.result.answers.target.answers, ['staging']);
    await act(async () => {
      acceptUpdateSnapshot({ ...idleUpdate(), id: 'job', state: 'settling', work: { blocking: [], willResume: [], unaffected: [], stale: [{ kind: 'interaction', taskId: 'task', owner: 'desktop', title: 'Earlier question' }] } });
    });
    const stale = within(panel.getByRole('region', { name: t('updates.stale') }));
    assert.ok(stale.getByText('Earlier question'));
    assert.equal(panel.queryByRole('button', { name: t('detail.sendAnswer') }), null);
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
    await act(async () => acceptUpdateSnapshot({ ...idleUpdate(), state: 'available', source: { kind: 'release', version: '1.2.4' } }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('viewUpdate'), exact: true })));
    assert.equal(updates.get().panelOpen, true);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await window.happyDOM.close();
    globalThis.fetch = previousFetch;
  }
});

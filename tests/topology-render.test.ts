import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h } from 'react';
import { lookupCallerConversations } from '../ui/state/callerConversations.ts';
import { within } from '@testing-library/dom';

test('arena snapshots retain an active native caller bubble while task_mark_read returns the completed group', async () => {
  // Regression: native model summaries invented ARC dispatchers and active callers lost their own task bubble.
  const window = new Window({ url: 'http://localhost' });
  const media = { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} disconnect() {} }
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    localStorage: window.localStorage, getComputedStyle: window.getComputedStyle.bind(window), matchMedia: window.matchMedia, ResizeObserver: Observer,
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1200, 800) as unknown as DOMRect;
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('main'); document.body.append(mount); const root = createRoot(mount);
  try {
    const { default: Topology } = await server.ssrLoadModule('/ui/topology/Topology.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { useActivityTracking, acceptActivity } = await server.ssrLoadModule('/ui/state/activity.ts');
    const { controlActivityBubble } = await server.ssrLoadModule('/ui/state/activityBubbles.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { viewModel } = await server.ssrLoadModule('/ui/runtimeSnapshot.ts');
    const candidates = [{ id: 'account', side: 'local', agent: 'codex', label: 'Fixture account', sourceIds: [], content: h('button', null, 'Fixture account') }];
    const conversations = [{ agent: 'claude', conversation: { id: 'caller', title: 'Fixture dispatcher', source: 'native', createdAt: null } }];
    function Harness() {
      const { tracked, markRead } = useActivityTracking();
      return h(Topology, { candidates, conversations, sessions: Object.entries(tracked).flatMap(([agent, rows]: any) => rows.map((session: any) => ({ agent, session }))), now: Date.now(), onRead: markRead });
    }
    await act(() => root.render(h(TooltipProvider, null, h(Harness))));
    const session = { id: 'executor', title: 'Fixture executor', source: 'codex-thread', phase: 'command', headline: 'Working', phaseSince: null, timeline: true,
      dispatchSummary: { caller: { agent: 'claude', conversationId: 'caller' } } };
    const nativeCaller = { id: 'caller', title: 'Fixture dispatcher', source: 'transcript', phase: 'command', headline: 'Native work', phaseSince: null, timeline: true, dispatchSummary: { model: 'native-model', effort: 'high' } };
    let observation = Date.now();
    const snapshot = async (sessions: any[]) => act(() => acceptActivity({ observedAt: new Date(++observation).toISOString(), activeAgents: ['codex'], agents: { codex: { sessions }, claude: { sessions: [nativeCaller] } } }));
    await snapshot([session]);
    const page = within(mount), model = () => viewModel().topology;
    assert.ok(page.getByRole('button', { name: 'Fixture account' }));
    assert.ok(page.getByRole('button', { name: name => name.startsWith('Fixture dispatcher') }));
    assert.ok(page.getByRole('button', { name: name => name.startsWith(session.title) }));
    assert.equal(model().kind, 'arena'); assert.doesNotThrow(() => JSON.stringify(model()));
    assert.deepEqual(model().candidates.map((c: any) => c.id), ['account']);
    assert.equal(model().loops.length, 1); assert.equal(model().loops[0].nodes.length, 2);
    assert.equal(model().loops[0].edges.length, 1); assert.equal(model().loops[0].depth, 1);
    assert.equal(model().loops[0].lingering, false);
    assert.ok(page.getByRole('button', { name: name => name.startsWith(nativeCaller.title) && name.includes(t('timeline.open')) }));
    assert.equal(model().loops[0].nodes.find((n: any) => n.taskId === nativeCaller.id)?.depth, 0);
    assert.equal(model().loops[0].nodes.some((n: any) => n.kind === 'unattributed'), false);
    await snapshot([]);
    assert.equal(model().loops[0].lingering, true);
    assert.equal(model().candidates[0].unread, true);
    await act(() => controlActivityBubble({ agent: 'codex', id: session.id, action: 'mark-read' }));
    assert.equal(model().loops.length, 0); assert.equal(model().candidates[0].unread, false);
    assert.equal(controlActivityBubble({ agent: 'codex', id: session.id }).unread, false);
    assert.equal(model().returning.length <= 2, true);
  } finally { await act(() => root.unmount()); await server.close(); await window.happyDOM.close(); }
});

test('dispatcher lookup resolves an unloaded conversation by native ID across metadata pages', async () => {
  // Regression: an Agent dispatcher without a loaded conversation title fell back to a bare account alias.
  const caller = { agent: 'claude', conversationId: 'native-caller' };
  const metadata = { id: 'arc-owned-id', nativeSessionId: caller.conversationId, title: 'Resolved caller title', source: 'arc-task' as const, createdAt: null, agentAccountId: 'caller-account' };
  const pages = { first: { data: [{ id: 'unrelated', source: 'native' as const, createdAt: null }], nextCursor: 'older', scope: 'arc-tasks' as const },
    older: { data: [metadata], nextCursor: null, scope: 'arc-tasks' as const } };
  const found = await lookupCallerConversations([caller], [{ agent: 'codex', conversation: { ...metadata, title: 'Other Agent' } }], async (_agent, cursor) => pages[cursor === 'older' ? 'older' : 'first']);
  assert.deepEqual(found, [{ agent: caller.agent, conversation: metadata }]);
});

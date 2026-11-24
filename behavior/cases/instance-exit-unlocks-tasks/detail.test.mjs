// Replay inputs from installed.py capture-detail while the provider gate is held.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { act, createElement as h } from 'react';
import { within } from '@testing-library/dom';
import { withDialog } from '../../../tests/helpers/layers-ui.ts';

const check = 'instance-exit-unlocks-tasks/running-status-shown';

// The old daemon still reports the turn active and the Desktop writer held.
// Use this facsimile only to exhibit the old renderer, never as candidate input.
function baseline() {
  const id = '00000000-0000-4000-8000-000000000019';
  const session = {id, turnId: 'active-turn', title: 'HB running', open: {taskId: id},
    source: 'codex-thread', phase: 'command', timeline: true, headline: 'Working', orderAt: 1};
  return {session, runtime: {title: session.title}, timeline: {
    status: 'running', coverage: {state: 'complete'}, entries: [], cursor: 0, turnStatuses: {'active-turn': 'running'},
    ownership: {state: 'held', owner: 'desktop'},
  }};
}

test(check + ' is visible with a usable reopen control', async () => {
  // Recurring bug class: lifecycle a surviving native turn lost its recovery action after the independent window exited.
  const sample = process.env.HANDBACK_DETAIL;
  if (!sample) throw Error('Specify HANDBACK_DETAIL=<captured JSON file>, or baseline for the legacy demonstration');
  const {session, runtime, timeline} = sample === 'baseline' ? baseline() : JSON.parse(await readFile(sample, 'utf8'));
  const original = globalThis.fetch;
  try {
    await withDialog(async ({server, root, settle}) => {
      window.history.replaceState(null, '', '/');
      globalThis.fetch = async input => {
        const route = String(input);
        if (route.includes('/agents/timeline/') || route.includes('/agents/conversations/timeline'))
          return Response.json(timeline);
        if (route.includes('/tasks/runtime/')) return Response.json(runtime);
        return Response.json({items: [], records: [], reviews: []});
      };
      const {agentActivity} = await server.ssrLoadModule('/ui/state/activity.ts');
      const {TooltipProvider} = await server.ssrLoadModule('/ui/components/ui/index.tsx');
      const {default: Detail} = await server.ssrLoadModule('/ui/components/ActivityTimeline.tsx');
      const {locale} = await server.ssrLoadModule('/ui/i18n.ts');
      agentActivity.set({snapshot: {agents: {codex: {sessions: [session]}}}, error: ''});
      locale.set('en');
      await act(async () => root.render(h(TooltipProvider, null, h(Detail, {
        agent: 'codex', session, onToggleWidth() {}, onBack() {},
      }))));
      await settle();
      const page = within(document.body);
      if (!page.queryByRole('heading', {name: runtime.title})) throw Error('The target task detail did not mount');
      const closed = page.queryAllByText(/window.{0,24}(closed|gone)|closed.{0,20}window/i);
      const running = page.queryAllByText(/still running|continues? (to run|running)/i);
      const reopen = page.queryByRole('button', {name: /re[ -]?open/i});
      const observations = {closed: !!closed.length, stillRunning: !!running.length,
        canReopen: !!reopen && !reopen.disabled && reopen.getAttribute('aria-disabled') !== 'true'};
      assert.deepEqual(observations, {closed: true, stillRunning: true, canReopen: true}, check);
    });
  } finally { globalThis.fetch = original; }
});

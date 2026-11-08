import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAttention, groupEvents, mergeEvents, type JournalEvent } from '../ui/coordination/model.ts';
import type { TrackedActivity } from '../ui/state/activityModel.ts';
import { axClosed, axDecision, axRows, axStatus, type AXEntry } from '../ui/coordination/axModel.ts';
const session: TrackedActivity = { id: 'thread-a', source: 'codex-thread', turnId: 'turn-a', title: 'Sample task', phase: 'idle', headline: '', phaseSince: null, timeline: true, orderAt: 1, observed: false, status: 'failed' };

test('AX reopen preserves history while separating the current disposition and status partition', () => {
  // Property: reopening moves a closed record to unfinished work without presenting an earlier decision as its current disposition.
  const closed: AXEntry = { id: 'AX-example', revision: 2, kind: 'friction', symptom: 'Native state stayed stale', expected: 'Refresh state', resources: [], source: { type: 'local-authority' }, occurrenceCount: 1, status: 'closed', resolution: 'fix',
    history: [{ action: 'fix', at: '2026-01-01T00:00:00Z', actor: { type: 'local-authority' }, revision: 2, detail: { commit: 'example' } }] };
  const reopened = { ...closed, status: 'open', resolution: null, history: [...closed.history, { action: 'reopen', at: '2026-01-02T00:00:00Z', actor: closed.source, revision: 3 }] };
  const merged = { ...closed, id: 'AX-merged', status: 'merged', resolution: 'merged' };
  assert.equal(axClosed(reopened), false);
  assert.equal(axStatus(reopened), 'open');
  assert.equal(axDecision(reopened), undefined);
  assert.equal(axDecision(closed)?.detail?.commit, 'example');
  assert.deepEqual(axRows([closed, merged], true, 'ax-MERGED').map(row => row.id), [merged.id]);
  assert.deepEqual(axRows([closed, reopened], false, '').map(row => row.history.length), [2]);
});

test('completion reads keep failures actionable until an evidenced successor recovers', () => {
  // Regression: homepage completion-read dismissal must not resolve event-center task attention.
  const failure = { status: 'failed', turnId: 'turn-a', turnStatuses: { 'turn-a': 'failed' }, interactions: [] };
  assert.equal(taskAttention({ codex: [session] }, { '["codex","thread-a"]': failure }, {}).length, 1);
  assert.equal(taskAttention({}, { '["codex","thread-a"]': failure }, {}).length, 1);
  const recovered = { ...failure, status: 'completed', turnId: 'turn-b', turnStatuses: { 'turn-a': 'failed', 'turn-b': 'completed' } };
  assert.deepEqual(taskAttention({ codex: [session] }, { '["codex","thread-a"]': recovered }, {}), []);
});

test('pending decisions take priority while unknown or unconfirmed execution stays outside attention', () => {
  // Regression: receipt stalling and unknown activity must not become fabricated questions or task failures.
  const pending = { ...session, observed: true, status: undefined, phase: 'interaction' as const, interaction: { kind: 'question' as const, summary: 'Choose', respond: { op: 'codex_respond' as const, args: { id: 'question-a' } } } };
  assert.deepEqual(taskAttention({ codex: [pending, pending] }, {}, {}).map(item => item.state), ['needsYou']);
  assert.deepEqual(taskAttention({ codex: [{ ...session, status: 'unconfirmed' }, { ...session, id: 'thread-b', status: undefined }] }, {}, {}), []);
});

test('event grouping preserves every distinct outcome and never merges unrelated turns', () => {
  // Property: grouping and replay deduplication preserve event identity, descending sequence and distinct turn scope.
  const make = (sequence: number, threadId: string, turnId: string): JournalEvent => ({ eventId: `event-${sequence}`, sequence, observedAt: '2026-01-01T00:00:00Z', kind: 'turn.terminal', summary: 'Terminal outcome', status: sequence === 1 ? 'failed' : 'completed', resources: [], threadRefs: [{ threadId, turnId }], evidenceRefs: [] });
  const rows = [make(1,'thread-a','turn-a'),make(2,'thread-a','turn-a'),make(3,'thread-a','turn-b'),make(4,'thread-b','turn-a')];
  const groups = groupEvents(mergeEvents(rows, rows));
  assert.deepEqual(groups.map(group => group.map(row => row.sequence)), [[4],[3],[2,1]]);
  assert.deepEqual(groups.flat().map(row => row.eventId).sort(), rows.map(row => row.eventId).sort());
});

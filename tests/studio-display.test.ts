import test from 'node:test';
import assert from 'node:assert/strict';
import { nextClockTick, studioActivitySummary } from '../ui/display/model.ts';
import { interactionKey, type TrackedActivity } from '../ui/state/activityModel.ts';

const session = (id: string, props: Partial<TrackedActivity> = {}): TrackedActivity => ({
  id, source: 'codex-thread', title: id, headline: id, phase: 'thinking', phaseSince: null, timeline: true, orderAt: 0, observed: true, turnId: 'turn-1', ...props,
});

test('clock refresh always reaches the next minute without a busy loop', () => {
  // Algorithmic core: studio clock scheduling
  for (const time of [-60_001, -1, 0, 1, 59_999, 60_000, 123_456_789]) {
    const delay = nextClockTick(time);
    assert.ok(delay > 0 && delay <= 60_000);
    assert.equal(Math.abs((time + delay) % 60_000), 0);
  }
});

test('studio counts only running and actionable pending tasks across agents', () => {
  // Algorithmic core: studio actionable task counting
  const pending = session('pending', { interaction: { kind: 'permission', summary: 'Read project files', canRespond: true, respond: { op: 'codex_respond', args: { id: 'request-1' } } } });
  const activity = { codex: [session('running'), pending, session('done', { observed: false, endedAt: 1, status: 'completed' }),
    session('unconfirmed', { observed: false }), session('failed', { observed: false, status: 'failed' })], claude: [session('another-running')] };
  assert.deepEqual(studioActivitySummary(activity, {}, {}), { running: 2, needsYou: 1 });
  assert.deepEqual(studioActivitySummary(activity, {}, { [interactionKey('codex', pending)]: { status: 'submitted', decision: 'allow', payload: { op: 'codex_respond', args: {} } } }), { running: 3, needsYou: 0 });
  assert.deepEqual(studioActivitySummary({}, {}, {}), { running: 0, needsYou: 0 });
});

test('studio does not restore answered requests from a stale activity snapshot', () => {
  // Algorithmic core: timeline-resolved requests and requests belonging to another turn do not require attention.
  const interaction = { kind: 'permission' as const, summary: 'Read project files', canRespond: true, respond: { op: 'codex_respond' as const, args: { id: 'request-1' } } };
  const pending = session('pending', { interaction });
  assert.deepEqual(studioActivitySummary({ codex: [pending] }, { [JSON.stringify(['codex', pending.id])]: {
    status: 'running', interactions: [{ id: 'resolved', type: 'interaction', status: 'completed', turnId: pending.turnId, interaction }],
  } }, {}), { running: 1, needsYou: 0 });
  assert.deepEqual(studioActivitySummary({ codex: [session('running')] }, { [JSON.stringify(['codex', 'running'])]: {
    status: 'running', interactions: [{ id: 'old', type: 'interaction', status: 'pending', turnId: 'previous-turn', interaction }],
  } }, {}), { running: 1, needsYou: 0 });
});

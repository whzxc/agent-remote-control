import test from 'node:test';
import assert from 'node:assert/strict';
import { arcPoint, IDLE_MS, maySpeak, petIntents, presentPet, relayPose, SPEECH_MS, STALL_MS, taskPetRow, type RelayTask } from '../ui/pets/relay.ts';
const task: RelayTask = { key: 'codex:t', taskId: 't', agent: 'codex', sourceId: 's', dispatchId: 'd', turn: 'turn-1', state: 'running', at: 0, phaseSince: 0 };
test('execution states keep distinct pet intents without changing execution evidence', () => {
  // Property: terminal outcomes, pending input and unknown evidence map independently without mutating their task.
  for (const state of ['running', 'needsYou', 'done', 'failed', 'interrupted', 'unknown'] as const) {
    const input = Object.freeze({ ...task, state });
    const intents = petIntents(input, undefined, 0);
    assert.equal(intents.some(i => i.kind === 'return'), ['done', 'failed', 'interrupted'].includes(state));
    assert.equal(input.state, state);
    assert.equal(taskPetRow(state), { running: 7, needsYou: 6, done: 0, failed: 5, interrupted: 5, unknown: 8 }[state]);
    assert.deepEqual(petIntents(input, input, 0), []);
  }
});
test('turn and review identities trigger independent relay events', () => {
  // Property: changing a turn or review produces one corresponding intent while identical snapshots produce none.
  const next = { ...task, turn: 'turn-2' };
  assert.deepEqual(petIntents(next, task, 0).map(i => i.kind), ['carry']);
  for (const verdict of ['pass', 'rework'] as const) {
    const reviewed = { ...task, review: { id: 'review-1', verdict } };
    assert.deepEqual(petIntents(reviewed, task, 0).map(i => i.kind), [verdict === 'pass' ? 'praise' : 'rework']);
    assert.deepEqual(petIntents(reviewed, reviewed, 0), []);
  }
  assert.equal(petIntents({ ...task, sourceId: undefined, dispatchId: undefined }, undefined, 0)[0].kind, 'carry');
});
test('stall eligibility requires running evidence and a bounded phase age', () => {
  // Property: only running tasks with a finite phase start at or beyond the stall threshold can urge.
  for (const state of ['running', 'needsYou', 'done', 'failed', 'interrupted', 'unknown'] as const) for (const phaseSince of [undefined, NaN, 0, 1]) {
    const input = { ...task, state, phaseSince };
    const urge = petIntents(input, undefined, STALL_MS).some(i => i.kind === 'urge');
    assert.equal(urge, state === 'running' && phaseSince === 0);
  }
});
test('card paths preserve endpoints and terminal colors', () => {
  // Property: card arcs retain both anchors and terminal results determine the throw-back color.
  const from = { x: 20, y: 100 }, to = { x: 300, y: 200 };
  assert.deepEqual(arcPoint(from, to, -1), from); assert.deepEqual(arcPoint(from, to, 2), to);
  assert.ok(arcPoint(from, to, .5).y < 150);
  for (const state of ['done', 'failed', 'interrupted'] as const) {
    const intent = petIntents({ ...task, state }, task, 0).find(i => i.kind === 'return')!;
    for (const now of [0, 500, 1000, 1600]) assert.equal(relayPose(intent, now).card?.tone, state === 'done' ? 'success' : 'danger');
    assert.ok(relayPose(intent, 5000).finished); assert.equal(relayPose(intent, 5000).card, undefined);
  }
});
test('residency and pair speech remain time-bounded', () => {
  // Property: only resident pairs outlive idle departure and speech never exceeds one line per pair per 30 seconds.
  for (const elapsed of [0, IDLE_MS - 1, IDLE_MS, IDLE_MS + 2000, IDLE_MS * 10]) {
    assert.ok(presentPet(0, true, elapsed).present);
    assert.equal(presentPet(0, false, elapsed).present, elapsed < IDLE_MS + 2000);
  }
  for (let elapsed = 0; elapsed < SPEECH_MS; elapsed += 100) assert.equal(maySpeak(0, elapsed), false);
  assert.ok(maySpeak(0, SPEECH_MS)); assert.ok(maySpeak(undefined, 0));
});

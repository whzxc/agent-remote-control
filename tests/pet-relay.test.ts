import test from 'node:test';
import assert from 'node:assert/strict';
import { arcPoint, IDLE_MS, maySpeak, pendingRelayUntil, petIntents, presentPet, queuePetIntent, relayPose, retainPetIntents, stepRelayQueue, visiblePetIntent, RELAY_MS, RELAY_READY_MS, SPEECH_MS, STALL_MS, taskPetRow, type PetIntent, type RelayTask } from '../ui/pets/relay.ts';
const task: RelayTask = { key: 'codex:t', taskId: 't', agent: 'codex', sourceId: 's', dispatchId: 'd', turn: 'turn-1', state: 'running', at: 0, phaseSince: 0 };
test('execution states keep distinct pet intents without changing execution evidence', () => {
  // Property: terminal outcomes, pending input and unknown evidence map independently without mutating their task.
  for (const state of ['running', 'needsYou', 'done', 'failed', 'interrupted', 'unknown'] as const) {
    const input = Object.freeze({ ...task, state });
    const intents = petIntents(input, task, 0);
    assert.equal(intents.some(i => i.kind === 'return'), ['done', 'failed', 'interrupted'].includes(state));
    assert.equal(input.state, state);
    assert.equal(taskPetRow(state), { running: 7, needsYou: 6, done: 0, failed: 5, interrupted: 5, unknown: 8 }[state]);
    assert.deepEqual(petIntents(input, input, 0), []);
  }
});
test('opening completed task history does not replay a result handoff', () => {
  // Regression: opening the workbench made historical completed tasks throw a new result despite no observed execution transition.
  for (const state of ['done', 'failed', 'interrupted'] as const) {
    assert.equal(petIntents({ ...task, state }, undefined, 0).some(intent => intent.kind === 'return'), false);
    assert.equal(petIntents({ ...task, state }, task, 0).some(intent => intent.kind === 'return'), true);
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
test('hydrating historical reviews establishes a baseline without replaying praise or rework', () => {
  // Regression: the first review poll replayed an old pass or rework after completed task history had already rendered.
  for (const verdict of ['pass', 'rework'] as const) {
    const historical: RelayTask = { ...task, state: 'done' };
    const baseline: RelayTask = { ...historical, review: { id: 'historical-review', verdict, baseline: true } };
    assert.deepEqual(petIntents(baseline, historical, 10), []);
    assert.deepEqual(petIntents(baseline, undefined, 10), []);
    const unchanged = { ...baseline, review: { ...baseline.review!, baseline: false } };
    assert.deepEqual(petIntents(unchanged, baseline, 20), []);
    const revised = { ...unchanged, review: { id: 'new-review', verdict, baseline: false } };
    assert.deepEqual(petIntents(revised, unchanged, 30).map(intent => intent.kind), [verdict === 'pass' ? 'praise' : 'rework']);
  }
});
test('the first review of an observed completion remains a live review event', () => {
  // Property: a live terminal transition and its subsequent first review each produce their own event exactly once.
  const completed: RelayTask = { ...task, state: 'done' };
  assert.deepEqual(petIntents(completed, task, 10).map(intent => intent.kind), ['return']);
  for (const verdict of ['pass', 'rework'] as const) {
    const reviewed: RelayTask = { ...completed, review: { id: 'first-live-review', verdict, baseline: false } };
    assert.deepEqual(petIntents(reviewed, completed, 20).map(intent => intent.kind), [verdict === 'pass' ? 'praise' : 'rework']);
    assert.deepEqual(petIntents(reviewed, reviewed, 30), []);
  }
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
    const flights = Array.from({ length: RELAY_MS / 50 }, (_, index) => relayPose(intent, index * 50).card).filter(Boolean);
    assert.ok(flights.length > 0);
    for (const card of flights) assert.equal(card!.tone, state === 'done' ? 'success' : 'danger');
    assert.ok(relayPose(intent, RELAY_MS).finished); assert.equal(relayPose(intent, RELAY_MS).card, undefined);
  }
});
test('relay ownership remains continuous through receiving, carrying and returning', () => {
  // Property: every active handoff has exactly one holder or one in-flight card, and receiving follows the card destination.
  for (const kind of ['dispatch', 'rework', 'return'] as const) {
    const event: PetIntent = { id: kind, kind, task: { ...task, state: kind === 'return' ? 'done' : 'running' }, at: 0 };
    const holders = new Set<string>(), flights = new Set<string>();
    let prior = relayPose(event, 0);
    for (let now = 0; now < RELAY_MS; now += 10) {
      const pose = relayPose(event, now);
      assert.equal(Number(!!pose.holding) + Number(!!pose.card), 1);
      if (pose.holding) holders.add(pose.holding);
      if (pose.card) flights.add(`${pose.card.from}:${pose.card.to}`);
      if (prior.card && pose.holding) assert.equal(pose.holding, prior.card.to);
      prior = pose;
    }
    assert.deepEqual(holders, new Set(['source', 'agent', 'task']));
    assert.deepEqual(flights, new Set(kind === 'return' ? ['task:agent', 'agent:source'] : ['source:agent', 'agent:task']));
    assert.equal(prior.holding, kind === 'return' ? 'source' : 'task');
    assert.equal(prior.taskAtAgent, false);
  }
});
test('native work returns to its real executor without an invented source', () => {
  // Property: an unattributed task has no source-bound flight or source ownership during its result handoff.
  const event: PetIntent = { id: 'native', kind: 'return', task: { ...task, sourceId: undefined, state: 'done' }, at: 0 };
  for (let now = 0; now < RELAY_MS; now += 10) {
    const pose = relayPose(event, now);
    assert.notEqual(pose.holding, 'source'); assert.notEqual(pose.card?.from, 'source'); assert.notEqual(pose.card?.to, 'source');
    assert.equal(Number(!!pose.holding) + Number(!!pose.card), 1);
  }
  assert.equal(relayPose(event, RELAY_MS - 1).holding, 'agent');
  assert.equal(petIntents({ ...task, sourceId: undefined }, task, STALL_MS).some(intent => intent.kind === 'urge'), false);
});
test('a recorded source without a visible participant uses executor-only choreography', () => {
  // Regression: local CLI tasks had a nonempty source ID but no source pet, so their relay waited for a nonexistent hand and timed out.
  const evidence = Object.freeze({ ...task, sourceId: 'builtin-local-cli' });
  const dispatch = Object.freeze({ id: 'cli-dispatch', kind: 'dispatch' as const, task: evidence, at: 0 });
  const sources = new Set(['visible-claude']);
  const visual = visiblePetIntent(dispatch, sources)!;
  assert.equal(visual.id, dispatch.id); assert.equal(visual.kind, 'carry');
  assert.equal(visual.task.sourceId, undefined); assert.equal(evidence.sourceId, 'builtin-local-cli');
  assert.equal(dispatch.kind, 'dispatch'); assert.equal(dispatch.task, evidence);
  const queue = queuePetIntent([], visual, 0);
  assert.deepEqual(queuePetIntent(queue, visiblePetIntent(dispatch, sources)!, 1), queue);
  assert.deepEqual(queuePetIntent(queue, visiblePetIntent({ ...dispatch, id: 'running', kind: 'carry' }, sources)!, 1), queue);
  const returned = visiblePetIntent({ ...dispatch, id: 'cli-return', kind: 'return', task: { ...evidence, state: 'done' } }, sources)!;
  for (let now = 0; now < RELAY_MS; now += 100) {
    const pose = relayPose(returned, now);
    assert.notEqual(pose.holding, 'source'); assert.notEqual(pose.card?.to, 'source');
  }
  assert.equal(relayPose(returned, RELAY_MS - 1).holding, 'agent');
  for (const kind of ['urge', 'praise', 'rework'] as const) assert.equal(visiblePetIntent({ ...dispatch, kind }, sources), undefined);
  assert.equal(visiblePetIntent(dispatch, new Set([evidence.sourceId])), dispatch);
});
test('simultaneous tasks serialize their cards and retain a quick result after its dispatch', () => {
  // Regression: concurrent task cards overlapped and quick completion erased the dispatch before its receiver could catch it.
  const dispatched: PetIntent = { id: 'dispatch', kind: 'dispatch', task, at: 0 };
  let queue = queuePetIntent([], dispatched, 0);
  queue = queuePetIntent(queue, { id: 'other', kind: 'dispatch', task: { ...task, key: 'other' }, at: 1 }, 1);
  queue = queuePetIntent(queue, { id: 'result', kind: 'return', task: { ...task, state: 'done' }, at: 2 }, 2);
  assert.deepEqual(queue.map(event => event.kind), ['dispatch', 'dispatch', 'return']);
  for (let index = 1; index < queue.length; index++) assert.ok(queue[index].at >= queue[index - 1].at + RELAY_MS);
  for (let now = 0; now < queue.at(-1)!.at + RELAY_MS; now += 10) assert.ok(queue.filter(event => event.at <= now && !relayPose(event, now).finished).length <= 1);
  assert.deepEqual(queuePetIntent(queue, dispatched, 2), queue);
});
test('a newer turn replaces stale choreography without changing unrelated work', () => {
  // Property: a task can retain only events from its current turn while independent tasks retain their evidence.
  const first: PetIntent = { id: 'first', kind: 'dispatch', task, at: 0 };
  const other: PetIntent = { id: 'other', kind: 'carry', task: { ...task, key: 'other' }, at: RELAY_MS };
  const next: PetIntent = { id: 'next', kind: 'dispatch', task: { ...task, turn: 'turn-2' }, at: 10 };
  const queue = queuePetIntent([first, other], next, 10);
  assert.deepEqual(queue.map(event => event.id), ['other', 'next']);
  assert.equal(queue[0].task, other.task); assert.equal(queue[1].task, next.task);
});
test('queued task pets remain available after the ordinary idle deadline until their final relay finishes', () => {
  // Regression: twelve dispatches followed by returns outlived the idle deadline, so later result cards had no task pet to throw them.
  const tasks = Array.from({ length: 12 }, (_, index) => ({ ...task, key: `task-${index}`, taskId: `task-${index}` }));
  let queue: PetIntent[] = [];
  for (const task of tasks) queue = queuePetIntent(queue, { id: `${task.key}:dispatch`, kind: 'dispatch', task, at: 0 }, 0);
  for (const task of tasks) queue = queuePetIntent(queue, { id: `${task.key}:return`, kind: 'return', task: { ...task, state: 'done' }, at: 1 }, 1);
  assert.ok(queue.filter(event => event.kind === 'return').every(event => event.at > IDLE_MS));
  for (const event of queue) for (const now of [event.at, event.at + RELAY_MS - 1]) {
    const remaining = queue.filter(item => item.at + RELAY_MS > now);
    const presence = presentPet(1, false, now, pendingRelayUntil(event.task, remaining));
    assert.ok(presence.present); assert.equal(presence.returning, false);
  }
  const end = queue.at(-1)!.at + RELAY_MS;
  assert.equal(presentPet(1, false, end, pendingRelayUntil(tasks.at(-1)!, [])).present, false);
  assert.equal(pendingRelayUntil({ ...tasks[0], turn: 'another-turn' }, queue), 0);
});
test('a missing rendered task bubble or replaced turn cancels its pending choreography', () => {
  // Property: only unexpired events whose exact task turn is still rendered can retain an actor or animate a card.
  const input = [
    { id: 'visible', kind: 'return' as const, task, at: 0 },
    { id: 'missing', kind: 'return' as const, task: { ...task, key: 'missing' }, at: RELAY_MS },
    { id: 'old-turn', kind: 'return' as const, task: { ...task, key: 'replaced' }, at: RELAY_MS * 2 },
  ];
  const visible = new Map([[task.key, task.turn], ['replaced', 'new-turn']]);
  const remaining = retainPetIntents(input, visible, 1);
  assert.deepEqual(remaining.map(event => event.id), ['visible']);
  assert.equal(pendingRelayUntil(input[1].task, remaining), 0);
  assert.deepEqual(retainPetIntents(input, visible, RELAY_MS), []);
  assert.deepEqual(input.map(event => event.id), ['visible', 'missing', 'old-turn']);
});
test('an entering task keeps its queued handoff until real actor anchors are available', () => {
  // Regression: an entering bubble had no frame at zero opacity, so dispatch was consumed before its task pet could receive the card.
  const first: PetIntent = { id: 'entering', kind: 'dispatch', task, at: 0 };
  const second: PetIntent = { id: 'second', kind: 'dispatch', task: { ...task, key: 'second' }, at: RELAY_MS };
  for (const entryDelay of [20, 800, RELAY_READY_MS - 1]) {
    let scheduled = stepRelayQueue([first, second], undefined, 0, () => false);
    scheduled = stepRelayQueue(scheduled.events, scheduled.clock, entryDelay, () => false);
    assert.equal(scheduled.events.length, 2);
    assert.equal(relayPose(scheduled.events[0], entryDelay).holding, 'source');
    assert.equal(relayPose(scheduled.events[0], entryDelay).card, undefined);
    scheduled = stepRelayQueue(scheduled.events, scheduled.clock, entryDelay, () => true);
    assert.equal(scheduled.clock?.waitingSince, undefined);
    assert.equal(scheduled.events[0].at, entryDelay);
    assert.ok(scheduled.events[1].at >= scheduled.events[0].at + RELAY_MS);
    assert.equal(relayPose(scheduled.events[0], entryDelay + 500).card?.from, 'source');
  }
});
test('a scene that cannot place its actors releases the relay channel after bounded waiting', () => {
  // Property: unavailable anchors cannot keep a task or later tasks in the choreography queue indefinitely.
  const unavailable: PetIntent = { id: 'unavailable', kind: 'dispatch', task, at: 0 };
  const retry: PetIntent = { id: 'return', kind: 'return', task: { ...task, state: 'done' }, at: RELAY_MS };
  const ready: PetIntent = { id: 'ready', kind: 'dispatch', task: { ...task, key: 'ready' }, at: RELAY_MS * 2 };
  const canPlay = (event: PetIntent) => event.id === ready.id;
  let scheduled = stepRelayQueue([unavailable, retry, ready], undefined, 0, canPlay);
  scheduled = stepRelayQueue(scheduled.events, scheduled.clock, RELAY_READY_MS, canPlay);
  assert.deepEqual(scheduled.events.map(event => event.id), ['ready']);
  assert.equal(scheduled.events[0].at, RELAY_READY_MS);
  assert.equal(scheduled.clock?.waitingSince, undefined);
  assert.equal(pendingRelayUntil(task, scheduled.events), 0);
});
test('losing an anchor freezes the current handoff phase without restarting or skipping it', () => {
  // Property: elapsed choreography time excludes intervals in which real actor anchors are unavailable.
  const event: PetIntent = { id: 'active', kind: 'dispatch', task, at: 0 };
  let scheduled = stepRelayQueue([event], undefined, 0, () => true);
  scheduled = stepRelayQueue(scheduled.events, scheduled.clock, 500, () => false);
  const paused = relayPose(scheduled.events[0], 500);
  scheduled = stepRelayQueue(scheduled.events, scheduled.clock, 1200, () => true);
  assert.deepEqual(relayPose(scheduled.events[0], 1200), paused);
  assert.ok(relayPose(scheduled.events[0], 1300).card!.progress > paused.card!.progress);
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

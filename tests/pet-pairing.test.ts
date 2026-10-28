import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLoopPair, taskColor, type RelayTask } from '../ui/pets/relay.ts';

const sources = new Set(['source-a', 'source-b']);
const agents = new Set(['agent-a', 'agent-b']);
const pairA = { sourceId: 'source-a', agent: 'agent-a' };
const pairB = { sourceId: 'source-b', agent: 'agent-b' };
function task(key: string, changes: Partial<RelayTask> = {}): RelayTask {
  return { key, taskId: key, turn: 'turn-1', state: 'running', at: 1, ...pairA, ...changes };
}

test('resident pets preserve an observed source and executor as one pair', () => {
  // Regression: independently selected recent source and executor could represent unrelated Loops.
  const observed = [task('first', { at: 2 }), task('second', { ...pairB, at: 4 })];
  assert.deepEqual(selectLoopPair(observed, undefined, sources, agents), pairB);
  assert.deepEqual(selectLoopPair(observed, undefined, new Set([...sources, 'unrelated-source']), new Set([...agents, 'unrelated-agent'])), pairB);
});

test('an active pair remains stable when an equally urgent Loop becomes newer', () => {
  // Property: recency changes alone cannot replace a resident pair at the same execution priority.
  for (const at of [2, 100, 1_000_000]) {
    assert.deepEqual(selectLoopPair([task('current'), task('newer', { ...pairB, at })], pairA, sources, agents), pairA);
  }
});

test('a Loop needing user input takes precedence over ongoing work', () => {
  // Property: a valid pending-input pair outranks a running pair regardless of recency.
  const pending = task('pending', { ...pairB, state: 'needsYou', at: 0 });
  assert.deepEqual(selectLoopPair([task('running', { at: 1000 }), pending], pairA, sources, agents), pairB);
  assert.deepEqual(selectLoopPair([pending, task('running', { at: 1000 })], pairA, sources, agents), pairB);
});

test('unattributed or unavailable participants cannot manufacture a pair', () => {
  // Property: a selected pair requires an observed source and two currently available participants.
  assert.equal(selectLoopPair([task('native', { sourceId: undefined })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([task('missing-source', { sourceId: 'removed-source' })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([task('missing-agent', { agent: 'removed-agent' })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([], pairA, new Set(['source-b']), agents), undefined);
  assert.equal(selectLoopPair([], pairA, sources, new Set(['agent-b'])), undefined);
});

test('the last known pair survives task retention while its participants remain available', () => {
  // Property: removing completed task evidence does not erase an already established valid pair.
  assert.deepEqual(selectLoopPair([], pairA, sources, agents), pairA);
  assert.deepEqual(selectLoopPair([task('unattributed', { sourceId: undefined })], pairA, sources, agents), pairA);
  assert.equal(selectLoopPair([], undefined, sources, agents), undefined);
});

test('pair selection leaves task evidence and caller ordering unchanged', () => {
  // Property: choosing a presentation pair never mutates input tasks, order, or the previous pair.
  const first = Object.freeze(task('first', { at: 1 }));
  const second = Object.freeze(task('second', { ...pairB, at: 2 }));
  const observed = Object.freeze([first, second]);
  const previous = Object.freeze({ ...pairA });
  const before = JSON.stringify({ observed, previous });
  selectLoopPair(observed, previous, sources, agents);
  assert.equal(JSON.stringify({ observed, previous }), before);
});

test('a task retains its identification color across repeated projections', () => {
  // Property: task identification color depends only on its stable task key.
  const keys = ['task-a', 'task-b', 'agent:task:turn', '任务一', ''];
  const first = new Map(keys.map(key => [key, taskColor(key)]));
  for (const key of [...keys].reverse()) assert.equal(taskColor(key), first.get(key));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCompanions, selectLoopPair, type RelayTask } from '../ui/pets/relay.ts';

const sources = new Set(['source-a', 'source-b']);
const agents = new Set(['agent-a', 'agent-b']);
const pairA = { sourceId: 'source-a', agent: 'agent-a' };
const pairB = { sourceId: 'source-b', agent: 'agent-b' };
function task(key: string, changes: Partial<RelayTask> = {}): RelayTask {
  return { key, taskId: key, turn: 'turn-1', state: 'running', at: 1, ...pairA, ...changes };
}

test('resident pets preserve an observed source and executor as one pair', () => {
  // Recurring bug class: independently selected recent source and executor could represent unrelated Loops.
  const observed = [task('first', { at: 2 }), task('second', { ...pairB, at: 4 })];
  assert.deepEqual(selectLoopPair(observed, undefined, sources, agents), pairB);
  assert.deepEqual(selectLoopPair(observed, undefined, new Set([...sources, 'unrelated-source']), new Set([...agents, 'unrelated-agent'])), pairB);
});

test('an active pair remains stable when an equally urgent Loop becomes newer', () => {
  // Algorithmic core: recency changes alone cannot replace a resident pair at the same execution priority.
  for (const at of [2, 100, 1_000_000]) {
    assert.deepEqual(selectLoopPair([task('current'), task('newer', { ...pairB, at })], pairA, sources, agents), pairA);
  }
});

test('a Loop needing user input takes precedence over ongoing work', () => {
  // Algorithmic core: a valid pending-input pair outranks a running pair regardless of recency.
  const pending = task('pending', { ...pairB, state: 'needsYou', at: 0 });
  assert.deepEqual(selectLoopPair([task('running', { at: 1000 }), pending], pairA, sources, agents), pairB);
  assert.deepEqual(selectLoopPair([pending, task('running', { at: 1000 })], pairA, sources, agents), pairB);
});

test('unattributed or unavailable participants cannot manufacture a pair', () => {
  // Algorithmic core: a selected pair requires an observed source and two currently available participants.
  assert.equal(selectLoopPair([task('native', { sourceId: undefined })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([task('missing-source', { sourceId: 'removed-source' })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([task('missing-agent', { agent: 'removed-agent' })], undefined, sources, agents), undefined);
  assert.equal(selectLoopPair([], pairA, new Set(['source-b']), agents), undefined);
  assert.equal(selectLoopPair([], pairA, sources, new Set(['agent-b'])), undefined);
});

test('the last known pair survives task retention while its participants remain available', () => {
  // Algorithmic core: removing completed task evidence does not erase an already established valid pair.
  assert.deepEqual(selectLoopPair([], pairA, sources, agents), pairA);
  assert.deepEqual(selectLoopPair([task('unattributed', { sourceId: undefined })], pairA, sources, agents), pairA);
  assert.equal(selectLoopPair([], undefined, sources, agents), undefined);
});

test('available companions can share an idle studio without establishing a Loop', () => {
  // Recurring bug class: the studio showed only one or no main pets until a task had an attributed source and executor.
  const participants = [
    { id: 'source:claude', kind: 'source' as const, brand: 'claude' },
    { id: 'agent:codex', kind: 'agent' as const, brand: 'codex' },
  ];
  assert.deepEqual(selectCompanions(participants), participants.map(participant => participant.id));
  assert.deepEqual(selectCompanions(participants.slice(1)), ['agent:codex']);
  assert.equal(selectLoopPair([], undefined, new Set(['claude']), new Set(['codex'])), undefined);
  assert.equal(selectLoopPair([task('native', { agent: 'codex', sourceId: undefined })], undefined, new Set(['claude']), new Set(['codex'])), undefined);
});

test('idle companions preserve their identities while those participants remain available', () => {
  // Algorithmic core: participant ordering and additional choices cannot replace an available resident of the same role.
  const participants = [
    { id: 'source:claude', kind: 'source' as const, brand: 'claude' }, { id: 'source:other', kind: 'source' as const, brand: 'other' },
    { id: 'agent:codex', kind: 'agent' as const, brand: 'codex' }, { id: 'agent:other', kind: 'agent' as const, brand: 'other' },
  ];
  const previous = ['source:other', 'agent:other'];
  assert.deepEqual(selectCompanions(participants, previous), previous);
  assert.deepEqual(selectCompanions([...participants].reverse(), previous), previous);
  assert.deepEqual(selectCompanions(participants.filter(participant => !previous.includes(participant.id)), previous), ['source:claude', 'agent:codex']);
});

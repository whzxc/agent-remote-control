import test from 'node:test';
import assert from 'node:assert/strict';
import { deckGeometry, deckRelease } from '../ui/components/taskDeck.ts';
import { taskCardActivity } from '../ui/state/taskProjection.ts';

test('deck depth is continuous across slots with compressed spacing and increasing fog', () => {
  // Property: continuous deck depth preserves order while scale and visible spacing recede monotonically.
  for (const stride of [34, 70, 132]) {
    let previous = deckGeometry(0, stride);
    for (let depth = .01; depth < 7; depth += .01) {
      const next = deckGeometry(depth, stride);
      assert.ok(next.offset > previous.offset);
      assert.ok(next.offset - previous.offset <= stride * .010001);
      assert.ok(next.scale <= previous.scale && next.fog >= previous.fog);
      previous = next;
    }
    for (let slot = 0; slot <= 7; slot++) {
      assert.ok(Math.abs(deckGeometry(slot - 1e-8, stride).offset - deckGeometry(slot + 1e-8, stride).offset) < 1e-4);
    }
  }
});
test('deck release stays within its tasks and velocity advances in gesture direction', () => {
  // Property: release targets valid whole slots and projected velocity never reverses browse direction.
  for (const count of [1, 3, 20]) for (const position of [-100, 0, 80, 4000]) {
    const atRest = deckRelease(position, 0, 70, count);
    assert.ok(deckRelease(position, -1, 70, count) <= atRest);
    assert.ok(deckRelease(position, 1, 70, count) >= atRest);
    assert.ok(atRest >= 0 && atRest <= (count - 1) * 70);
    assert.equal(atRest % 70, 0);
  }
});
test('snapshot retains source, request and reply in observation order with the newest row last', () => {
  // Property: the bounded snapshot preserves chronological roles and always includes the newest supported observation.
  const result = taskCardActivity([
    { id: 'source', type: 'user', text: 'Inspect the queue' },
    ...Array.from({ length: 15 }, (_, i) => ({ id: `step-${i}`, type: 'command' as const, command: `step ${i}` })),
    { id: 'request', type: 'interaction', status: 'pending', text: 'Choose a target' },
    { id: 'reply', type: 'text', text: 'Queue ready' },
  ]);
  assert.ok(result.snapshot.length <= 10);
  assert.deepEqual(result.snapshot.slice(-2).map(row => [row.role, row.text]), [['request', 'Choose a target'], ['agent', 'Queue ready']]);
  assert.equal(taskCardActivity([{ id: 'source', type: 'user', text: 'Inspect the queue' }]).snapshot[0].role, 'source');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCardActivity } from '../ui/state/taskProjection.ts';

test('snapshot retains source, request and reply in observation order with the newest row last', () => {
  // Property: the bounded snapshot preserves chronological roles and always includes the newest supported observation.
  const result = taskCardActivity([
    { id: 'source', type: 'user', text: 'Inspect the queue' },
    ...Array.from({ length: 15 }, (_, i) => ({ id: `step-${i}`, type: 'command' as const, command: `step ${i}` })),
    { id: 'request', type: 'interaction', status: 'pending', text: 'Choose a target' },
    { id: 'reply', type: 'text', text: 'Queue ready' },
  ]);
  assert.ok(result.snapshot.length <= 80);
  assert.deepEqual(result.snapshot.slice(-2).map(row => [row.role, row.text]), [['request', 'Choose a target'], ['agent', 'Queue ready']]);
  assert.equal(taskCardActivity([{ id: 'source', type: 'user', text: 'Inspect the queue' }]).snapshot[0].role, 'source');
});

test('snapshot shows the input of a Codex exec tool', () => {
  // Regression: Codex exec rows showed only the tool name although the input was recorded.
  const projected = taskCardActivity([{ id: 'tool', type: 'tool', title: 'exec', status: 'running', input: { text: 'const result = await tools.exec_command({ cmd: "pwd" });' } }]);
  assert.equal(projected.snapshot[0].kind, 'tool');
  assert.match(projected.snapshot[0].text, /cmd: "pwd"/);
});

test('tall snapshots retain the bounded history beyond ten rows', () => {
  // Regression: full-height task cards still projected only ten rows, leaving earlier content inaccessible.
  const projected = taskCardActivity(Array.from({ length: 100 }, (_, index) => ({ id: `command-${index}`, type: 'command' as const, command: `step ${index}` })));
  assert.equal(projected.snapshot.length, 80);
  assert.equal(projected.snapshot[0].text, 'step 20');
  assert.equal(projected.snapshot.at(-1)?.text, 'step 99');
});

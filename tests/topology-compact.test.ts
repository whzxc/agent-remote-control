import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoots, type ActivityEntity } from '../ui/topology/compact.ts';
import { DEFAULTS } from '../ui/topology/solve.ts';

const node = (id: string, activityLevel = 0, activityAt = 0): ActivityEntity => ({ id, tasks: [], activityLevel, activityAt });
test('height compaction preserves each side and prioritizes current work over old activity', () => {
  // Property: compaction retains the busiest root of each nonempty side regardless of input order or viewport pressure.
  for (const orientation of ['portrait', 'landscape'] as const) for (const vh of [260, 500]) {
    const left = [node('old', 0, 900), node('source-active', 2, 1), node('idle', 0, 1)];
    const right = [node('agent-idle'), node('agent-active', 2, 1), node('recent', 0, 900)];
    const result = compactRoots(left, right, { vw: 700, vh }, orientation, DEFAULTS);
    assert.ok(!result.left.has('source-active'));
    assert.ok(!result.right.has('agent-active'));
    assert.ok(result.left.size < left.length && result.right.size < right.length);
  }
});
test('selected descendants and pending decisions stay reachable without expanding a stack', () => {
  // Regression: height-based hiding could remove the selected panel anchor or an actionable pending decision.
  const left = [{ ...node('selected-parent'), children: [{ ...node('child'), selected: true }] }, node('source-active', 2), node('source-idle')];
  const right = [{ ...node('pending'), attention: true }, node('agent-active', 2), node('agent-idle')];
  const result = compactRoots(left, right, { vw: 700, vh: 300 }, 'portrait', DEFAULTS);
  assert.ok(!result.left.has('selected-parent'));
  assert.ok(!result.right.has('pending'));
  assert.ok(result.left.has('source-idle') && result.right.has('agent-idle'));
});
test('ample space restores all nodes without mutating their order', () => {
  // Property: fitting scenes have no overflow and compaction never mutates the input groups.
  const left = [node('source-b'), node('source-a')], right = [node('agent-b'), node('agent-a')];
  const before = JSON.stringify([left, right]);
  compactRoots(left, right, { vw: 700, vh: 260 }, 'portrait', DEFAULTS);
  const roomy = compactRoots(left, right, { vw: 1400, vh: 2000 }, 'portrait', DEFAULTS);
  assert.equal(roomy.left.size + roomy.right.size, 0);
  assert.equal(JSON.stringify([left, right]), before);
});

test('landscape leaves the fitting wing alone while compacting the overflowing wing', () => {
  // Regression: globally ranked compaction hid idle sources even when only the Agent wing exceeded the available height.
  const left = [node('source-a'), node('source-b')];
  const right = [{ ...node('busy'), tasks: [{ id: 'work', width: 264, height: 800, state: 'running' }] }, node('idle-a'), node('idle-b')];
  const result = compactRoots(left, right, { vw: 1400, vh: 400 }, 'landscape', DEFAULTS);
  assert.equal(result.left.size, 0);
  assert.ok(!result.right.has('busy'));
  assert.ok(result.right.size > 0);
});

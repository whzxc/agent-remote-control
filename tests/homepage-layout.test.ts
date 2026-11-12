import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTopology } from '../ui/topology/layout.ts';
import { integrateSpring } from '../ui/topology/spring.ts';

test('configuration positions ignore task observations', () => {
  // Property: only configuration, viewport and explicit disclosure determine topology positions.
  const roots = [{ id: 'agent', children: [{ id: 'one', account: true }, { id: 'two', account: true }] }];
  const options = { compact: true, pitch: 152, hubX: 140, hubY: 240, expanded: new Set<string>() };
  const before = layoutTopology([], roots, options);
  const working = roots.map(node => ({ ...node, attention: true, activityLevel: 3, activityAt: 100 }));
  const after = layoutTopology([], working, options);
  assert.deepEqual(after.nodes.map(({ id, x, y }) => ({ id, x, y })), before.nodes.map(({ id, x, y }) => ({ id, x, y })));
  assert.deepEqual(after.groups.map(group => group.members.map(member => member.id)), [['one', 'two']]);
  const expanded = layoutTopology([], roots, { ...options, expanded: new Set(['agent']) });
  assert.deepEqual(expanded.nodes.map(node => node.id), ['agent', 'one', 'two']);
  assert.deepEqual(expanded.nodes[0], before.nodes[0]);
});

test('capsule spring converges from either direction and supports retargeting', () => {
  // Property: shared spring integration converges to its current target without changing unrelated anchors.
  for (const [start, target] of [[48, 188], [188, 48]]) {
    const value = { x: start, v: 0, t: target };
    for (let index = 0; index < 240; index++) integrateSpring(value, 1 / 60, 210, 26);
    assert.equal(value.x, target);
    value.t = start;
    for (let index = 0; index < 240; index++) integrateSpring(value, 1 / 60, 210, 26);
    assert.equal(value.x, start);
  }
});

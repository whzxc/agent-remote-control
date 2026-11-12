import test from 'node:test';
import assert from 'node:assert/strict';
import { integrateSpring } from '../ui/topology/spring.ts';
import { solve, type Entity } from '../ui/topology/solve.ts';

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

test('task observations do not enter the node solver', () => {
  // Regression: task activity changed topology positions, queues and compaction before homepage modes.
  const roots: Entity[] = [{ id: 'agent', children: [{ id: 'account-one' }, { id: 'account-two' }] }];
  const scene = { vw: 1280, vh: 800, left: [], right: roots };
  const before = solve(scene);
  const observed = roots.map(node => ({ ...node, tasks: [{ id: 'unprojected-task', width: 400, height: 600 }], activityLevel: 3 }));
  assert.deepEqual(solve({ ...scene, right: observed }), before);
});

test('capsule extent keeps child branches and controls beyond its task segment', () => {
  // Regression: the old outer arc intercepted a working capsule task segment because its width was absent from node geometry.
  for (const width of [48, 104, 160]) {
    const layout = solve({ vw: 1920, vh: 1050, left: [], right: [{ id: 'agent', extent: width, children: [{ id: 'account' }] }] });
    const [parent, child] = layout.wings[1].nodes;
    assert.equal(parent.extent, width);
    assert.ok(parent.arc!.R > (width - 24) * parent.size / 44);
    assert.ok(child.x - child.size / 2 - 6 > parent.x + parent.arc!.R);
    assert.ok(layout.hub.x + layout.balance[1].full <= layout.vw);
  }
});

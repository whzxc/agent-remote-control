import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTopology, topologyRoute } from '../ui/topology/layout.ts';
import { integrateSpring } from '../ui/topology/spring.ts';

test('configuration positions ignore task observations', () => {
  // Property: only configuration, viewport and explicit disclosure determine topology positions.
  const roots = [{ id: 'agent', children: [{ id: 'one', account: true }, { id: 'two', account: true }] }];
  const options = { width: 640, height: 800, expanded: new Set<string>() };
  const before = layoutTopology([], roots, options);
  const working = roots.map(node => ({ ...node, attention: true, activityLevel: 3, activityAt: 100 }));
  const after = layoutTopology([], working, options);
  assert.deepEqual(after.nodes.map(({ id, x, y }) => ({ id, x, y })), before.nodes.map(({ id, x, y }) => ({ id, x, y })));
  assert.deepEqual(after.groups.map(group => group.members.map(member => member.id)), [['one', 'two']]);
  const expanded = layoutTopology([], roots, { ...options, expanded: new Set(['agent']) });
  assert.deepEqual(expanded.nodes.map(node => node.id), ['agent', 'one', 'two']);
  assert.equal(expanded.nodes[0].id, before.nodes[0].id);
  assert.ok(expanded.nodes.every(node => node.y > 0));
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


test('portrait configuration separates source rows, ARC and executor rows', () => {
  // Regression: the portrait source column and its trunk overlapped ARC while account groups extended beyond the viewport.
  const accounts = (id: string) => [{ id: `${id}-one`, account: true }, { id: `${id}-two`, account: true }];
  const left = ['anthropic', 'xai', 'openai'].map(id => ({ id, children: accounts(id) }));
  const right = ['codex', 'claude', 'dsh', 'opencode'].map(id => ({ id, children: ['codex', 'claude'].includes(id) ? accounts(id) : [] }));
  for (const viewport of [{ width: 800, height: 1250 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const scene = layoutTopology(left, [...right, { id: 'device', deviceId: 'member', children: [] }], { ...viewport, expanded: new Set() });
    assert.equal(scene.groups.length, 5);
    if (scene.compact) {
      assert.ok(scene.nodes.filter(node => node.side === -1).every(node => node.y < scene.hub.y - scene.hub.size / 2));
      assert.ok(scene.nodes.filter(node => node.side === 1).every(node => node.y > scene.hub.y + scene.hub.size / 2));
    }
    const route = topologyRoute({ ...scene.add, side: 1 }, undefined, scene.hub, scene.compact, 48, true);
    assert.deepEqual(route.at(-1), scene.add);
    assert.ok(scene.groups.every(group => group.node.x > 0 && group.node.x < viewport.width));
  }
});

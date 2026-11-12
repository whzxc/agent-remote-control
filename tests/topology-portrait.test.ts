import test from 'node:test';
import assert from 'node:assert/strict';
import { solvePortrait } from '../ui/topology/portrait.ts';
import { DEFAULTS, solve, type Entity } from '../ui/topology/solve.ts';
import { TopologyAnimator, nodeKey } from '../ui/topology/animate.ts';

const left: Entity[] = [{ id: 'source', children: [{ id: 'source/a' }, { id: 'source/b' }] }];
const right: Entity[] = [{ id: 'idle/a' }, { id: 'agent', children: [{ id: 'account/a' }, { id: 'account/b' }] }, { id: 'single' }, { id: 'idle/b' }];

test('portrait preserves configuration order and inward child columns', () => {
  // Property: inward hierarchy preserves identity and input order without mutating configuration.
  for (const vw of [320, 600, 900, 1400]) {
    const scene = { vw, vh: 1000, left, right }, before = JSON.stringify(scene);
    const layout = solvePortrait(scene), [sources, agents] = layout.wings;
    assert.equal(JSON.stringify(scene), before);
    assert.ok(layout.sceneH >= scene.vh);
    assert.ok(sources.nodes.every(node => node.y < layout.hub.y));
    assert.ok(agents.nodes.every(node => node.y > layout.hub.y));
    assert.deepEqual(agents.nodes.filter(node => !node.parent).map(node => node.id), right.map(node => node.id));
    for (const node of [...sources.nodes, ...agents.nodes]) if (node.parent) {
      const parent = [...sources.nodes, ...agents.nodes].find(parent => parent.id === node.parent)!;
      assert.ok(node.side * (node.x - parent.x) < 0);
    }
  }
});

test('orientation changes reuse live node primitives', () => {
  // Property: changing solvers preserves every surviving stable ID and reduced motion reaches its destination directly.
  const scene = { vw: 900, vh: 1200, left, right }, animator = new TopologyAnimator();
  animator.setTargets(solve(scene)); animator.step(0, true);
  const node = animator.live.get(nodeKey(1, 'account/a'));
  const portrait = solvePortrait(scene);
  animator.setTargets(portrait); animator.step(0, true);
  assert.equal(animator.live.get(nodeKey(1, 'account/a')), node);
  for (const wing of portrait.wings) for (const node of wing.nodes) assert.equal(animator.values(nodeKey(wing.side, node.id))!.y, node.y);
});

test('collapsed subtrees and flat nodes retain their configuration semantics', () => {
  // Property: portrait neither expands collapsed descendants nor invents account levels for flat inputs.
  const collapsed = solvePortrait({ vw: 900, vh: 1200, left, right: [{ ...right[1], collapsed: true }] });
  assert.deepEqual(collapsed.wings[1].nodes.map(node => node.id), ['agent']);
  const flat = solvePortrait({ vw: 900, vh: 1200, left: [], right: right[1].children! });
  assert.ok(flat.wings[1].nodes.every(node => node.parent === undefined));
  assert.deepEqual(flat.wings[1].nodes.map(node => node.id), right[1].children!.map(node => node.id));
});

test('portrait source panel selection preserves topology geometry', () => {
  // Property: Source panel selection preserves node geometry while its slot is owned by layerFrame.
  for (const vw of [600, 900, 1080]) {
    const scene = { vw, vh: 1200, left, right };
    const closed = solvePortrait(scene);
    for (const selected of ['source', 'source/a', 'source/b']) {
      const open = solvePortrait({ ...scene, panel: { side: -1, selected, edge: 0 } });
      assert.deepEqual(open.hub, closed.hub);
      for (const [i, wing] of open.wings.entries()) {
        assert.deepEqual(wing.nodes.map(n => [n.id, n.x, n.y]), closed.wings[i].nodes.map(n => [n.id, n.x, n.y]));
      }

    }
  }
});

test('portrait Agent panel selection preserves node positions', () => {
  // Property: Agent panel selection preserves node order and identity independently of layer geometry.
  const scene = { vw: 900, vh: 1200, left, right };
  const closed = solvePortrait(scene);
  for (const id of ['agent', 'account/a', 'single']) {
    const open = solvePortrait({ ...scene, panel: { side: 1, selected: id, edge: 0 } });
    assert.deepEqual(open.wings[1].nodes.map(n => [n.id, n.x, n.y]), closed.wings[1].nodes.map(n => [n.id, n.x, n.y]));
  }
});
test('orientation springs settle within a bounded transition and can reverse', () => {
  // Property: reversing orientation retains primitives and converges to the latest solver without nonfinite coordinates.
  const scene = { vw: 900, vh: 1200, left, right }, animator = new TopologyAnimator();
  const landscape = solve(scene), portrait = solvePortrait(scene);
  animator.setTargets(landscape); animator.step(0, true);
  const node = animator.live.get(nodeKey(1, 'account/a'));
  animator.setTargets(portrait);
  for (let frame = 0; frame < 8; frame++) animator.step(1 / 60);
  animator.setTargets(landscape);
  for (let frame = 0; frame < 24; frame++) animator.step(1 / 60);
  assert.equal(animator.live.get(nodeKey(1, 'account/a')), node);
  for (const wing of landscape.wings) for (const n of wing.nodes) {
    const actual = animator.values(nodeKey(wing.side, n.id))!;
    assert.equal(actual.x, n.x); assert.equal(actual.y, n.y);
    assert.ok(Object.values(actual).every(Number.isFinite));
  }
  assert.equal(animator.step(1 / 60), false);
});

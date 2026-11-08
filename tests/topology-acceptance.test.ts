import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { readPortraitTopology } from '../tooling/acceptance/portrait-topology.mjs';
import { compactRoots, compactLayout, topologyGroups } from '../ui/topology/compact.ts';
import { DEFAULTS, type Scene } from '../ui/topology/solve.ts';
import type { Orientation } from '../ui/topology/orientation.ts';
import { denseTopologyScene } from './helpers/topology-dense.ts';
import { representedTopologyRoots } from '../tooling/acceptance/topology.mjs';

function snapshot(scene: Scene, orientation: Orientation) {
  const plan = compactRoots(scene.left, scene.right, scene, orientation, DEFAULTS);
  const groups = [...topologyGroups(scene.left, plan.left, -1), ...topologyGroups(scene.right, plan.right, 1)];
  const layout = compactLayout(scene, plan, new Set(), DEFAULTS, orientation);
  const nodes = layout.wings.flatMap(w => w.nodes.map(n => ({ ...n, group: groups.find(g => g.id === n.id && g.side === n.side),
    position: { presence: 1, op: n.opacity } })));
  return { orientation, orientationPending: false, nodes, groups: groups.map(g => ({ ...g, folded: true,
    position: nodes.find(n => n.id === g.id && n.side === g.side)!.position })),
    tasks: layout.wings.flatMap(w => w.tasks.map(t => ({ ...t, position: { op: t.hidden ? 0 : 1 } }))) };
}

const position = { presence: 1 };
test('acceptance counts the real dense fixture including grouped roots', () => {
  // Regression: the dense check missed the fifth Agent after homepage selection dropped it before folding.
  const { fixture, scene } = denseTopologyScene();
  const topology = snapshot(scene, 'landscape');
  assert.deepEqual(representedTopologyRoots(topology, 1), fixture.agents);
  assert.deepEqual(representedTopologyRoots(topology, -1), scene.left.map(n => n.id));
});

test('coverage retains root identity across unfolding and side collapse', () => {
  // Property: folded root membership and unfolded real roots cover the same identities without counting child groups, dormant groups or the opposite wing.
  const members = ['a', 'b', 'c'];
  for (const side of [-1, 1]) {
    const group = { side, members, folded: true, position };
    const folded = { groups: [group], nodes: [{ id: 'capsule', side, group: {}, position }] };
    const open = { groups: [{ ...group, folded: false }], nodes: members.map(id => ({ id, side, position })) };
    assert.deepEqual(representedTopologyRoots(folded, side), representedTopologyRoots(open, side));
    assert.deepEqual(representedTopologyRoots(open, -side), []);
    assert.deepEqual(representedTopologyRoots({ groups: [{ ...group, folded: false }], nodes: [] }, side), []);
  }
});

test('the portrait read path returns the snapshot rather than a function handle', async () => {
  // Regression: portrait-topology-4 evaluated an arrow-function string as a truthy handle whose jsonValue was undefined.
  const fixture = JSON.parse(readFileSync(new URL('../tooling/acceptance/scenarios/portrait-topology-4.json', import.meta.url), 'utf8'));
  const scene = { vw: fixture.viewports[0].width, vh: fixture.viewports[0].height,
    left: fixture.sourceProducts.map((id: string) => ({ id, tasks: [] })),
    right: fixture.agents.map((id: string) => ({ id, tasks: fixture.tasks.flatMap((task: any, i: number) => task.agent === id
      ? [{ id: `task-${i}`, state: 'running', width: 264, height: 76 }] : []) })) };
  const topology = snapshot(scene, 'portrait');
  // Match Playwright's string-expression evaluation and JSON handle serialization.
  const page = { waitForFunction: async (expression: string) => {
    const value = runInNewContext(expression, { window: { __ARC_VIEW_MODEL__: () => ({ topology }) } });
    return { jsonValue: async () => typeof value === 'function' ? undefined : value, dispose: async () => {} };
  } };
  const read = await readPortraitTopology(page, { sources: fixture.sourceProducts.length, agents: fixture.agents.length, tasks: fixture.tasks.length });
  assert.deepEqual(read, topology);
});

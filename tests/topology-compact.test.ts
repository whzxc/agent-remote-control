import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoots, compactLayout, compactTree, topologyGroups, topologyGroupId, topologyPinned, type ActivityEntity } from '../ui/topology/compact.ts';
import { denseTopologyScene } from './helpers/topology-dense.ts';
import { DEFAULTS, type Entity } from '../ui/topology/solve.ts';

const node = (id: string, activityLevel = 0, activityAt = 0): ActivityEntity => ({ id, attention: activityLevel > 0, activityAt });
const empty = () => ({ left: new Set<string>(), right: new Set<string>() });
const flatten = (list: readonly Entity[]): Entity[] => list.flatMap(n => [n, ...flatten(n.children ?? [])]);

test('compaction preserves each nonempty side and its highest ranked root', () => {
  // Property: attention and stable ID choose the protected root independently of input order and height pressure.
  for (const orientation of ['portrait', 'landscape'] as const) for (const vh of [200, 400, 800]) {
    for (const best of [node('best', 2), node('best', 1, 900), node('a')]) {
      const left = [node('z'), best, node('y'), node('x')], right = [...left].reverse();
      const result = compactRoots(left, right, { vw: 700, vh }, orientation, DEFAULTS);
      assert.ok(!result.left.has(best.id)); assert.ok(!result.right.has(best.id));
      assert.ok(result.left.size < left.length && result.right.size < right.length);
    }
  }
});

test('groups never include pinned nodes or ancestors of pinned nodes', () => {
  // Property: selection, attention and explicit node pins protect every ancestor against compaction.
  const pins: Partial<ActivityEntity>[] = [{ selected: true }, { attention: true }, { pinned: true }];
  for (const orientation of ['portrait', 'landscape'] as const) for (const pin of pins) {
    const tree = [{ ...node('ancestor'), children: [{ ...node('pinned'), ...pin }, node('child-a'), node('child-b')] }, node('a'), node('b'), node('c')];
    const plan = compactRoots(tree, tree, { vw: 700, vh: 240 }, orientation, DEFAULTS);
    for (const hidden of [plan.left, plan.right]) { assert.ok(!hidden.has('ancestor')); assert.ok(!hidden.has('pinned')); }
  }
});

test('every parent has at most one nonsingleton group with stable identity', () => {
  // Property: sibling compaction creates at most one group per parent, each with at least two members and identity derived only from parent and side.
  const tree = Array.from({ length: 5 }, (_, i) => ({ ...node(`root-${i}`), children: Array.from({ length: 5 }, (_, j) => node(`child-${i}-${j}`)) }));
  for (const orientation of ['portrait', 'landscape'] as const) for (const vh of [200, 500, 900]) {
    const plan = compactRoots(tree, tree, { vw: 900, vh }, orientation, DEFAULTS);
    for (const side of [-1, 1] as const) {
      const groups = topologyGroups(tree, side === -1 ? plan.left : plan.right, side);
      assert.equal(new Set(groups.map(g => g.parent)).size, groups.length);
      for (const group of groups) { assert.ok(group.members.length >= 2); assert.equal(group.id, topologyGroupId(group.parent, side)); }
    }
  }
});

test('idle siblings fold as a complete eligible set at every depth', () => {
  // Property: any folded idle sibling implies all idle non-pinned peers are folded except the highest-ranked root of a nonempty side.
  const idle = (n: Entity): boolean => !(n as ActivityEntity).attention && !(n.children ?? []).some(c => !idle(c));
  for (const orientation of ['landscape', 'portrait'] as const) for (const count of [3, 5, 8]) for (const vh of [300, 600, 900, 1200]) {
    const roots = [{ ...node('busy', 2), tasks: [{ id: 'running', width: 264, height: 76, state: 'running' }], children: [
      { ...node('pinned-child'), selected: true }, ...Array.from({ length: count }, (_, i) => node(`child-${i}`, i % 2, i)),
    ] }, { ...node('pinned-root'), selected: true }, ...Array.from({ length: count }, (_, i) => node(`root-${i}`, i % 2, i))];
    const plan = compactRoots(roots, roots, { vw: 900, vh }, orientation, DEFAULTS);
    for (const side of [-1, 1] as const) for (const group of topologyGroups(roots, side === -1 ? plan.left : plan.right, side)) {
      const siblings = group.parent ? flatten(roots).find(n => n.id === group.parent)!.children! : roots;
      const eligible = siblings.filter(n => idle(n) && !topologyPinned(n as ActivityEntity));
      if (eligible.some(n => group.members.includes(n.id))) assert.ok(eligible.every(n => group.members.includes(n.id)));
    }
  }
});

test('kept siblings retain order and their group follows them in the parent column', () => {
  // Property: replacing folded siblings preserves the relative order and ancestry of kept siblings and appends one group at that depth.
  const roots = [{ ...node('parent'), children: ['a', 'b', 'c', 'd'].map(id => node(id)) }];
  const hidden = new Set(['a', 'c']);
  const make = (g: { id: string }): Entity => ({ id: g.id, tasks: [] });
  const tree = compactTree<Entity>(roots, hidden, 1, new Set(), make);
  assert.deepEqual(tree[0].children!.map(n => n.id), ['b', 'd', topologyGroupId('parent', 1)]);
  const open = compactTree<Entity>(roots, hidden, 1, new Set([topologyGroupId('parent', 1)]), make);
  assert.deepEqual(new Set(flatten(open).map(n => n.id)), new Set(flatten(roots).map(n => n.id)));
  assert.deepEqual(flatten(compactTree<Entity>(roots, new Set(['a']), 1, new Set(), make)).map(n => n.id), flatten(roots).map(n => n.id));
});

test('folded subtrees contribute no nodes, ports or child branches', () => {
  // Property: folded members and their descendants never enter layout, while each folded group contributes exactly one incoming branch.
  const roots = Array.from({ length: 5 }, (_, i) => ({ ...node(`root-${i}`, i === 0 ? 2 : 0), tasks: [{ id: `work-${i}`, width: 264, height: 76, state: i === 0 ? 'running' : 'done' }], children: [node(`child-${i}`)] }));
  for (const orientation of ['portrait', 'landscape'] as const) {
    const scene = { vw: 900, vh: 400, left: [], right: roots }, plan = compactRoots([], roots, scene, orientation, DEFAULTS);
    const groups = topologyGroups(roots, plan.right, 1);
    assert.ok(groups.length > 0);
    const folded = compactLayout(scene, plan, new Set(), DEFAULTS, orientation);
    const open = compactLayout(scene, plan, new Set(groups.map(g => g.id)), DEFAULTS, orientation);
    for (const group of groups) {
      const ids = new Set(flatten(flatten(roots).filter(n => group.members.includes(n.id))).map(n => n.id));
      assert.equal(folded.wings[1].nodes.filter(n => n.id === group.id).length, 1);
      assert.ok(folded.wings[1].nodes.every(n => !ids.has(n.id) && (!n.parent || !ids.has(n.parent))));
      assert.ok(group.members.every(id => open.wings[1].nodes.some(n => n.id === id)));
    }
  }
});

test('every input node is visible or belongs to exactly one folded subtree', () => {
  // Property: compaction and expansion partition every input node at every depth into one visible node or one folded group's subtree, without loss or duplication.
  const nested = Array.from({ length: 4 }, (_, i) => ({ ...node(`root-${i}`), children: Array.from({ length: 3 }, (_, j) => ({ ...node(`child-${i}-${j}`),
    children: [node(`leaf-${i}-${j}-0`), { ...node(`leaf-${i}-${j}-1`), selected: i === 0 && j === 0 }] })) }));
  const dense = denseTopologyScene().scene;
  for (const tree of [nested, dense.right]) for (const orientation of ['landscape', 'portrait'] as const) for (const vh of [300, 700, 1200]) {
    const scene = { vw: 1280, vh, left: tree, right: tree }, plan = compactRoots(tree, tree, scene, orientation, DEFAULTS);
    const allGroups = [...topologyGroups(tree, plan.left, -1), ...topologyGroups(tree, plan.right, 1)];
    for (const expanded of [new Set<string>(), new Set(allGroups.map(g => g.id)), new Set(allGroups.slice(0, 1).map(g => g.id))]) {
      const layout = compactLayout(scene, plan, expanded, DEFAULTS, orientation);
      for (const wing of layout.wings) {
        const groups = allGroups.filter(g => g.side === wing.side), input = flatten(tree);
        const counts = new Map(input.map(n => [n.id, 0]));
        for (const node of wing.nodes) if (counts.has(node.id)) counts.set(node.id, counts.get(node.id)! + 1);
        for (const group of groups.filter(g => !expanded.has(g.id))) for (const id of group.members) {
          for (const node of flatten([input.find(n => n.id === id)!])) counts.set(node.id, counts.get(node.id)! + 1);
        }
        assert.ok([...counts.values()].every(count => count === 1));
        const compacted = compactTree(tree, wing.side === -1 ? plan.left : plan.right, wing.side, expanded, g => ({ id: g.id, tasks: [] }));
        assert.deepEqual(new Set(flatten(compacted).map(n => n.id)), new Set(wing.nodes.map(n => n.id)));
        assert.equal(new Set(wing.nodes.map(n => n.id)).size, wing.nodes.length);
      }
    }
  }
});

test('the dense fixture represents every configured Agent after compaction', () => {
  // Regression: the dense fixture used unsupported limit 5 and hid an Agent.
  const { fixture, roots, scene } = denseTopologyScene();
  const plan = compactRoots(scene.left, scene.right, scene, 'landscape', DEFAULTS);
  const groups = topologyGroups(scene.right, plan.right, 1);
  const layout = compactLayout(scene, plan, new Set(), DEFAULTS, 'landscape');
  const actual = [...layout.wings[1].nodes.filter(n => !n.parent && roots.some(root => root.id === n.id)).map(n => n.id),
    ...groups.filter(g => !g.parent).flatMap(g => g.members)];
  assert.deepEqual(new Set(actual), new Set(fixture.agents));
});

test('account siblings fold before unrelated roots under height pressure', () => {
  // Regression: Codex account rows previously folded unrelated Agent roots before eligible children.
  const children = Array.from({ length: 11 }, (_, i) => ({ ...node(`account-${i}`), attention: i < 3 }));
  const roots = [{ ...node('codex'), children }, ...['claude', 'opencode', 'dsh', 'cursor'].map(id => node(id))];
  const scene = { vw: 1280, vh: 800, left: [], right: roots };
  const plan = compactRoots([], roots, scene, 'landscape', DEFAULTS);
  const groups = topologyGroups(roots, plan.right, 1);
  assert.ok(groups.some(group => group.parent === 'codex'));
  assert.ok(children.slice(0, 3).every(child => !plan.right.has(child.id)));
});

test('ample space restores all nodes without mutating input order', () => {
  // Property: fitting scenes have no folded members and planning never mutates the input trees.
  const roots = [{ ...node('root'), children: [node('b'), node('a')] }, node('other')], before = JSON.stringify(roots);
  compactRoots(roots, roots, { vw: 700, vh: 260 }, 'portrait', DEFAULTS);
  const roomy = compactRoots(roots, roots, { vw: 1400, vh: 2000 }, 'portrait', DEFAULTS);
  assert.equal(roomy.left.size + roomy.right.size, 0); assert.equal(JSON.stringify(roots), before);
});

test('landscape compacts only the overflowing wing', () => {
  // Regression: globally ranked compaction hid fitting sources when only the Agent wing exceeded its height budget.
  const left = [node('source-a'), node('source-b')];
  const right = [{ ...node('busy'), attention: true, children: Array.from({ length: 12 }, (_, i) => ({ ...node(`account-${i}`), pinned: true })) }, node('idle-a'), node('idle-b')];
  const result = compactRoots(left, right, { vw: 1400, vh: 400 }, 'landscape', DEFAULTS);
  assert.equal(result.left.size, 0); assert.ok(!result.right.has('busy')); assert.equal(result.right.size, 2);
});

test('empty portrait wings release reserved height and budget', () => {
  // Regression: a folded portrait wing left vacant space above the hub and unnecessarily folded the remaining wing.
  const viewport = { vw: 700, vh: 1000 };
  for (const count of [1, 4, 8]) {
    const roots = Array.from({ length: count }, (_, i) => node(`root-${i}`));
    const agentOnly = compactLayout({ ...viewport, left: [], right: roots }, empty(), new Set(), DEFAULTS, 'portrait');
    const sourceOnly = compactLayout({ ...viewport, left: roots, right: [] }, empty(), new Set(), DEFAULTS, 'portrait');
    for (const layout of [agentOnly, sourceOnly]) assert.ok(Math.abs((layout.portrait!.sourceTop + layout.portrait!.agentBottom) / 2 - viewport.vh / 2) < .001);
    assert.equal(agentOnly.portrait!.sourceTop, agentOnly.portrait!.sourceBottom);
    assert.equal(sourceOnly.portrait!.agentTop, sourceOnly.portrait!.agentBottom);
    assert.ok(agentOnly.wings[1].nodes.every(n => n.y > agentOnly.hub.y)); assert.ok(sourceOnly.wings[0].nodes.every(n => n.y < sourceOnly.hub.y));
  }
});


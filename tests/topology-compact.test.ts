import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRoots, compactLayout, compactTree, topologyGroups, topologyGroupId, topologyPinned, type ActivityEntity } from '../ui/topology/compact.ts';
import { solvePortrait } from '../ui/topology/portrait.ts';
import { DEFAULTS, type Entity } from '../ui/topology/solve.ts';

const node = (id: string, activityLevel = 0, activityAt = 0): ActivityEntity => ({ id, tasks: [], activityLevel, activityAt });
const empty = () => ({ left: new Set<string>(), right: new Set<string>() });
const flatten = (list: readonly Entity[]): Entity[] => list.flatMap(n => [n, ...flatten(n.children ?? [])]);

test('compaction preserves each nonempty side and its highest ranked root', () => {
  // Property: activity level, activity time and stable ID choose the protected root independently of input order and height pressure.
  for (const orientation of ['portrait', 'landscape'] as const) for (const vh of [200, 400, 800]) {
    for (const best of [node('best', 2), node('best', 0, 900), node('a')]) {
      const left = [node('z'), best, node('y'), node('x')], right = [...left].reverse();
      const result = compactRoots(left, right, { vw: 700, vh }, orientation, DEFAULTS);
      assert.ok(!result.left.has(best.id)); assert.ok(!result.right.has(best.id));
      assert.ok(result.left.size < left.length && result.right.size < right.length);
    }
  }
});

test('groups never include pinned nodes or ancestors of pinned nodes', () => {
  // Property: selection, attention, pending input, running tasks and selected tasks protect every ancestor against compaction.
  const pins: Partial<ActivityEntity>[] = [
    { selected: true }, { attention: true }, { tasks: [{ id: 'pending', width: 264, height: 76, pending: true }] },
    { tasks: [{ id: 'input', width: 264, height: 76, state: 'needsYou' }] },
    { tasks: [{ id: 'running', width: 264, height: 76, state: 'running' }] },
    { tasks: [{ id: 'chosen', width: 264, height: 76, selected: true }] },
  ];
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
  const idle = (n: Entity): boolean => !n.tasks.length && !(n.children ?? []).some(c => !idle(c));
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

test('folded subtrees contribute no nodes, ports or task branches', () => {
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
      assert.ok(folded.wings[1].tasks.every(t => !ids.has(t.parent)));
      assert.ok(group.members.every(id => open.wings[1].nodes.some(n => n.id === id)));
    }
  }
});

test('eleven Codex accounts fold eight idle children before any other roots', () => {
  // Regression: one Codex root with 11 accounts kept all idle account rows while unrelated Agent roots were folded into parallel wires.
  const children = Array.from({ length: 11 }, (_, i) => ({ ...node(`account-${String(i).padStart(2, '0')}`, i < 3 ? 2 : 0),
    tasks: i < 3 ? Array.from({ length: i === 0 ? 2 : 1 }, (_, j) => ({ id: `task-${i}-${j}`, width: 264, height: 76, state: i === 1 ? 'done' : 'running' })) : [] }));
  const roots = [{ ...node('codex'), children }, ...['claude', 'opencode', 'dsh', 'cursor'].map(id => node(id))];
  const scene = { vw: 1280, vh: 1000, left: [], right: roots };
  const plan = compactRoots([], roots, scene, 'landscape', DEFAULTS);
  const groups = topologyGroups(roots, plan.right, 1);
  assert.deepEqual(groups.map(g => [g.parent, g.members]), [['codex', children.slice(3).map(n => n.id)]]);
  assert.ok(roots.every(n => !plan.right.has(n.id)));
  const dense = compactRoots([], roots, { ...scene, vh: 800 }, 'landscape', DEFAULTS);
  assert.deepEqual(topologyGroups(roots, dense.right, 1).map(g => [g.parent, g.members.length]), [['codex', 8], [undefined, 4]]);
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
  const right = [{ ...node('busy'), tasks: [{ id: 'work', width: 264, height: 800, state: 'running' }] }, node('idle-a'), node('idle-b')];
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

test('portrait compacts sources first and centers the visible task group', () => {
  // Regression: equal budgets folded the lower Agent wing first and left running tasks below the vertical center.
  const left = ['openai', 'anthropic', 'google', 'xai'].map(id => node(id)), viewport = { vw: 640, vh: 800 };
  for (const count of [0, 2, 4]) {
    const right = [{ ...node('codex'), tasks: Array.from({ length: count }, (_, i) => ({ id: `task-${i}`, height: 76, width: 264, state: 'running' })) }, node('claude'), node('opencode')];
    const plan = compactRoots(left, right, viewport, 'portrait', DEFAULTS, solvePortrait({ ...viewport, left, right }));
    assert.equal(plan.left.size > 0, count === 4); assert.equal(plan.right.size, 0);
    const packed = compactLayout({ ...viewport, left, right }, plan, new Set(), DEFAULTS, 'portrait');
    const tasks = packed.wings[1].tasks;
    const anchor = count === 4 ? (tasks[0].y + tasks.at(-1)!.y) / 2 : (packed.portrait!.sourceTop + packed.portrait!.agentBottom) / 2;
    assert.ok(Math.abs(anchor - viewport.vh / 2) < .001); assert.equal(packed.sceneH, viewport.vh);
  }
});

import { solve, type Entity, type Layout, type Params, type Scene, type Side, type Task, type Wing } from './solve.ts';
import { solvePortrait } from './portrait.ts';
import type { Orientation } from './orientation.ts';

export interface ActivityEntity extends Entity {
  tasks: readonly (Task & { state?: string; pending?: boolean; selected?: boolean })[];
  activityAt?: number; activityLevel?: number; selected?: boolean; attention?: boolean;
  children?: ActivityEntity[];
}
export interface CompactPlan { left: Set<string>; right: Set<string> }
function priority(node: ActivityEntity): { level: number; at: number; pinned: boolean } {
  const children = (node.children ?? []).map(priority);
  return {
    level: Math.max(node.activityLevel ?? 0, ...node.tasks.map(t => t.pending || t.state === 'needsYou' ? 3 : t.state === 'running' ? 2 : 0), ...children.map(c => c.level)),
    at: Math.max(node.activityAt ?? 0, ...children.map(c => c.at)),
    pinned: !!node.selected || !!node.attention || node.tasks.some(t => t.selected || t.pending || t.state === 'needsYou') || children.some(c => c.pinned),
  };
}
function branches(wing: Wing) {
  return wing.nodes.filter(n => !n.parent).map(root => {
    const ids = new Set([root.id]);
    for (const node of wing.nodes) if (node.parent && ids.has(node.parent)) ids.add(node.id);
    const nodes = wing.nodes.filter(n => ids.has(n.id)), tasks = wing.tasks.filter(t => ids.has(t.parent));
    const top = Math.min(...nodes.map(n => n.y - n.size * n.scale / 2 - 12), ...tasks.map(t => t.y - t.height / 2 - 10));
    const bottom = Math.max(...nodes.map(n => n.y + n.size * n.scale / 2 + 24), ...tasks.map(t => t.y + t.height / 2 + 10));
    return { root, nodes, tasks, top, height: bottom - top };
  });
}
// Solve the entire tree first, then compact each depth onto its existing axis.
// Identity, parent edges and input order survive both folding and unfolding.
function foldWing(wing: Wing, hidden: Set<string>, gap: number) {
  const groups = branches(wing), kept = groups.filter(g => !hidden.has(g.root.id)), folded = groups.filter(g => hidden.has(g.root.id));
  let y = 0;
  for (const group of kept) {
    const delta = y - group.top;
    for (const n of group.nodes) n.y += delta;
    for (const t of group.tasks) t.y += delta;
    y += group.height + gap;
  }
  if (folded.length) {
    const levels = new Map<number, Wing['nodes']>();
    for (const group of folded) {
      const depths = new Map<string, number>();
      for (const node of group.nodes) {
        const depth = node.parent ? (depths.get(node.parent) ?? 0) + 1 : 0;
        depths.set(node.id, depth);
        levels.set(depth, [...(levels.get(depth) ?? []), node]);
      }
      for (const t of group.tasks) t.hidden = true;
    }
    let height = 0;
    for (const nodes of levels.values()) {
      const x = nodes[0].x, size = Math.max(...nodes.map(n => n.size * n.scale));
      const span = size + Math.max(0, nodes.length - 1) * 10 + 24;
      height = Math.max(height, span);
      nodes.forEach((n, i) => {
        const dx = x - n.x;
        if (n.taskBusX !== undefined) n.taskBusX += dx;
        if (n.childBusX !== undefined) n.childBusX += dx;
        n.x = x; n.y = y + size / 2 + i * 10; n.opacity = 1; n.dim = false;
      });
    }
    y += height + gap;
  }
  wing.H = Math.max(0, y - gap);
}
export function compactLayout(layout: Layout, plan: CompactPlan, expanded: ReadonlySet<Side>, gap: number): Layout {
  const result: Layout = { ...layout, hub: { ...layout.hub }, portrait: layout.portrait && { ...layout.portrait },
    wings: layout.wings.map(w => ({ ...w, nodes: w.nodes.map(n => ({ ...n })), tasks: w.tasks.map(t => ({ ...t })) })) };
  for (const wing of result.wings) foldWing(wing, expanded.has(wing.side) ? new Set() : wing.side === -1 ? plan.left : plan.right, gap);
  const [left, right] = result.wings;
  const p = result.portrait;
  const shift = (wing: Wing, dy: number) => { wing.nodes.forEach(n => n.y += dy); wing.tasks.forEach(t => t.y += dy); };
  if (p) {
    const hubGap = Math.min(56, result.hub.Re / 2), middle = 2 * (hubGap + p.earOffset);
    const half = Math.max(0, (result.vh - 74 - 112 - middle) / 2, left.H, right.H);
    p.sourceTop = 74 + (half - left.H) / 2; p.sourceBottom = p.sourceTop + left.H;
    result.hub.y = 74 + half + middle / 2;
    p.agentTop = result.hub.y + middle / 2 + (half - right.H) / 2; p.agentBottom = p.agentTop + right.H;
    shift(left, p.sourceTop); shift(right, p.agentTop);
    result.sceneH = Math.max(result.vh, 74 + half * 2 + middle + 112);
  } else {
    result.sceneH = Math.max(result.vh, left.H + 140, right.H + 140);
    result.hub.y = result.sceneH / 2;
    for (const wing of result.wings) shift(wing, result.hub.y - wing.H / 2);
  }
  return result;
}
export function compactRoots(left: ActivityEntity[], right: ActivityEntity[], viewport: Pick<Scene, 'vw' | 'vh'>, orientation: Orientation, params: Params): CompactPlan {
  const scene = { ...viewport, left, right };
  const layout = orientation === 'portrait' ? solvePortrait(scene, params) : solve(scene, params);
  const plan: CompactPlan = { left: new Set(), right: new Set() };
  const middle = layout.portrait ? 2 * (layout.portrait.earOffset + Math.min(56, layout.hub.Re / 2)) : 0;
  const budget = orientation === 'portrait' ? (viewport.vh - 74 - 112 - middle) / 2 : viewport.vh - 140;
  for (const [index, list] of [left, right].entries()) {
    const ranked = [...list].sort((a, b) => priority(b).level - priority(a).level || priority(b).at - priority(a).at || a.id.localeCompare(b.id));
    const hidden = index === 0 ? plan.left : plan.right;
    for (const node of ranked.slice(1).reverse()) {
      if (compactLayout(layout, plan, new Set(), params.rowGap).wings[index].H <= budget) break;
      if (!priority(node).pinned) hidden.add(node.id);
    }
  }
  return plan;
}

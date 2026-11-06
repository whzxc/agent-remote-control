import { solve, type Entity, type Layout, type Params, type Scene, type Side, type Task, type Wing } from './solve.ts';
import { portraitHubClearance, portraitInset, solvePortrait } from './portrait.ts';
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
    if (root.rowHeight !== undefined) return { root, nodes, tasks, top: root.y - root.rowHeight / 2, height: root.rowHeight };
    const top = Math.min(...nodes.map(n => n.y - n.size * n.scale / 2 - 12), ...tasks.map(t => t.y - t.height / 2 - 10));
    const bottom = Math.max(...nodes.map(n => n.y + n.size * n.scale / 2 + 24), ...tasks.map(t => t.y + t.height / 2 + 10));
    return { root, nodes, tasks, top, height: bottom - top };
  });
}
// Solve the entire tree first, then compact each depth onto its existing axis.
// Identity, parent edges and input order survive both folding and unfolding.
function foldWing(wing: Wing, hidden: ReadonlySet<string>, gap: number, portrait: boolean) {
  const groups = branches(wing), kept = groups.filter(g => !hidden.has(g.root.id)), folded = groups.filter(g => hidden.has(g.root.id));
  let y = 0;
  for (const group of kept) {
    const delta = y - group.top;
    for (const n of group.nodes) n.y += delta;
    for (const t of group.tasks) t.y += delta;
    y += group.height + gap;
  }
  if (folded.length) {
    if (portrait && kept.length) y -= gap * 2 / 3;
    const step = portrait ? 7 : 10;
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
      const span = size + (nodes.length - 1) * step + (portrait ? 0 : 24);
      height = Math.max(height, span);
      nodes.forEach((n, i) => {
        const dx = x - n.x;
        if (n.taskBusX !== undefined) n.taskBusX += dx;
        if (n.childBusX !== undefined) n.childBusX += dx;
        n.x = x; n.y = y + size / 2 + i * step; n.opacity = 1; n.dim = false;
      });
    }
    y += height + gap;
  }
  wing.H = Math.max(0, y - gap);
  return kept.flatMap(group => group.tasks);
}
const noRoots = new Set<string>();
const copyWing = (wing: Wing): Wing => ({ ...wing, nodes: wing.nodes.map(n => ({ ...n })), tasks: wing.tasks.map(t => ({ ...t })) });
export function compactLayout(layout: Layout, plan: CompactPlan, expanded: ReadonlySet<Side>, gap: number): Layout {
  const result: Layout = { ...layout, hub: { ...layout.hub }, portrait: layout.portrait && { ...layout.portrait },
    wings: layout.wings.map(copyWing) };
  const [left, right] = result.wings;
  const p = result.portrait;
  const leftRoots = expanded.has(-1) ? noRoots : plan.left, rightRoots = expanded.has(1) ? noRoots : plan.right;
  foldWing(left, leftRoots, gap, !!p);
  const tasks = foldWing(right, rightRoots, gap, !!p);
  const shift = (wing: Wing, dy: number) => { wing.nodes.forEach(n => n.y += dy); wing.tasks.forEach(t => t.y += dy); };
  if (p) {
    const clearance = portraitHubClearance(result.hub.Re), agentOffset = left.H + 2 * clearance;
    const height = agentOffset + right.H;
    let anchor = height / 2;
    const focusTasks = left.nodes.length > 0 && right.nodes.length > 0 && (leftRoots.size > 0 || rightRoots.size > 0) && tasks.length > 0;
    if (focusTasks) {
      const first = Math.min(...tasks.map(t => t.y - t.height / 2));
      const last = Math.max(...tasks.map(t => t.y + t.height / 2));
      anchor = agentOffset + (first + last) / 2;
    }
    p.sourceTop = Math.max(focusTasks ? 16 : portraitInset, result.vh / 2 - anchor); p.sourceBottom = p.sourceTop + left.H;
    result.hub.y = p.sourceBottom + clearance;
    p.agentTop = p.sourceTop + agentOffset; p.agentBottom = p.agentTop + right.H;
    shift(left, p.sourceTop); shift(right, p.agentTop);
    result.sceneH = Math.max(result.vh, p.agentBottom + portraitInset);
  } else {
    result.sceneH = Math.max(result.vh, left.H + 140, right.H + 140);
    result.hub.y = result.sceneH / 2;
    for (const wing of result.wings) shift(wing, result.hub.y - wing.H / 2);
  }
  return result;
}
export function compactRoots(left: readonly ActivityEntity[], right: readonly ActivityEntity[], viewport: Pick<Scene, 'vw' | 'vh'>, orientation: Orientation, params: Params, solved?: Layout): CompactPlan {
  const scene = { ...viewport, left, right };
  const layout = solved ?? (orientation === 'portrait' ? solvePortrait(scene, params) : solve(scene, params));
  const plan: CompactPlan = { left: new Set(), right: new Set() };
  const portrait = !!layout.portrait;
  const budget = portrait ? viewport.vh - 2 * (portraitInset + portraitHubClearance(layout.hub.Re)) : viewport.vh - 140;
  const heights = layout.wings.map(wing => {
    if (portrait) return wing.H;
    const copy = copyWing(wing);
    foldWing(copy, noRoots, params.rowGap, portrait);
    return copy.H;
  });
  for (const [index, list] of [left, right].entries()) {
    const height = () => portrait ? heights[0] + heights[1] : heights[index];
    if (height() <= budget) continue;
    const ranked = list.map(node => ({ id: node.id, ...priority(node) }))
      .sort((a, b) => b.level - a.level || b.at - a.at || a.id.localeCompare(b.id));
    const hidden = index === 0 ? plan.left : plan.right;
    let bestHeight = heights[index], best = new Set<string>();
    for (const node of ranked.slice(1).reverse()) {
      if (height() <= budget) break;
      if (node.pinned) continue;
      hidden.add(node.id);
      const copy = copyWing(layout.wings[index]);
      foldWing(copy, hidden, params.rowGap, portrait);
      heights[index] = copy.H;
      if (portrait && copy.H < bestHeight) {
        bestHeight = copy.H;
        best = new Set(hidden);
      }
    }
    if (portrait) {
      heights[index] = bestHeight;
      if (index === 0) plan.left = best;
      else plan.right = best;
    }
  }
  return plan;
}

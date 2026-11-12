import { solve, distribute, type Entity, type Layout, type Params, type Scene, type Side } from './solve.ts';
import { portraitInset, portraitMobileBreakpoint, solvePortrait } from './portrait.ts';
import type { Orientation } from './orientation.ts';

export interface ActivityEntity extends Entity {
  activityAt?: number; activityLevel?: number; selected?: boolean; attention?: boolean; pinned?: boolean;
  children?: ActivityEntity[];
}
export interface CompactPlan { left: Set<string>; right: Set<string> }
export interface TopologyGroupPlan { id: string; parent?: string; side: Side; members: string[] }
export const topologyGroupId = (parent: string | undefined, side: Side) => JSON.stringify(['group', side, parent ?? null]);
function priority(node: ActivityEntity): { level: number; at: number; pinned: boolean } {
  const children = (node.children ?? []).map(priority);
  return {
    level: Math.max(node.attention ? 1 : 0, ...children.map(c => c.level)),
    at: 0,
    pinned: !!node.pinned || !!node.selected || !!node.attention || children.some(c => c.pinned),
  };
}
export const topologyPinned = (node: ActivityEntity) => priority(node).pinned;
const rank = (list: readonly ActivityEntity[]) => list.map(node => ({ id: node.id, ...priority(node) }))
  .sort((a, b) => b.level - a.level || b.at - a.at || a.id.localeCompare(b.id));

export function topologyGroups(list: readonly Entity[], hidden: ReadonlySet<string>, side: Side, parent?: string): TopologyGroupPlan[] {
  const members = list.filter(n => hidden.has(n.id)).map(n => n.id);
  return [...list.filter(n => !hidden.has(n.id)).flatMap(n => topologyGroups(n.children ?? [], hidden, side, n.id)),
    ...(members.length >= 2 ? [{ id: topologyGroupId(parent, side), parent, side, members }] : [])];
}

// Replace sibling subtrees before solving: a capsule owns exactly one incoming
// branch, and folded members never enter the node/port layout.
export function compactTree<T extends Entity>(list: readonly T[], hidden: ReadonlySet<string>, side: Side, expanded: ReadonlySet<string>, group: (plan: TopologyGroupPlan, members: T[]) => T, parent?: string): T[] {
  const members = list.filter(n => hidden.has(n.id));
  if (members.length < 2) return list.map(n => ({ ...n, children: compactTree((n.children ?? []) as T[], hidden, side, expanded, group, n.id) }));
  const id = topologyGroupId(parent, side);
  const kept = list.filter(n => !hidden.has(n.id)).map(n => ({ ...n, children: compactTree((n.children ?? []) as T[], hidden, side, expanded, group, n.id) }));
  return [...kept, ...(expanded.has(id) ? members.map(n => ({ ...n })) : [group({ id, parent, side, members: members.map(n => n.id) }, members)])];
}

export function compactLayout(scene: Scene, plan: CompactPlan, expanded: ReadonlySet<string>, params: Params, orientation: Orientation): Layout {
  const group = (g: TopologyGroupPlan): Entity => ({ id: g.id });
  const sc = { ...scene, left: compactTree(scene.left, plan.left, -1, expanded, group), right: compactTree(scene.right, plan.right, 1, expanded, group) };
  const groups = [...topologyGroups(scene.left, plan.left, -1), ...topologyGroups(scene.right, plan.right, 1)];
  const result = orientation === 'portrait' ? solvePortrait(sc, params) : solve(sc, params);
  for (const wing of result.wings) for (const node of wing.nodes) {
    if (groups.some(g => g.side === wing.side && g.id === node.id)) { node.dim = false; node.opacity = 1; }
  }
  if (!result.portrait) {
    // Landscape budgets reserve the complete visible branch, including labels,
    // as before. Solver row compression must not erase that clearance.
    for (const wing of result.wings) {
      let y = 0;
      for (const root of wing.nodes.filter(n => !n.parent)) {
        const ids = new Set([root.id]);
        const collect = (parent: string) => { for (const n of wing.nodes.filter(n => n.parent === parent)) { ids.add(n.id); collect(n.id); } };
        collect(root.id);
        const nodes = wing.nodes.filter(n => ids.has(n.id));
        const top = Math.min(...nodes.map(n => n.y - n.size * n.scale / 2 - 12));
        const bottom = Math.max(...nodes.map(n => n.y + n.size * n.scale / 2 + 24));
        const dy = y - top;
        nodes.forEach(n => n.y += dy);
        y += bottom - top + params.rowGap;
      }
      wing.H = Math.max(0, y - params.rowGap);
    }
    result.sceneH = Math.max(result.vh, ...result.wings.map(w => w.H + 140));
    result.hub.y = result.sceneH / 2;
    for (const wing of result.wings) {
      const dy = result.hub.y - wing.H / 2;
      wing.nodes.forEach(n => n.y += dy);
      const roots = wing.nodes.filter(n => !n.parent);
      const angles = distribute(roots.map(n => Math.atan2(n.y - result.hub.y, Math.abs(n.x - result.hub.x)) * 180 / Math.PI), params.earFollow, params.earSep, params.earMax);
      roots.forEach((n, i) => n.port = angles[i]);
      wing.ear = { lo: Math.min(-params.earMin, (angles[0] ?? 0) - params.earPad), hi: Math.max(params.earMin, (angles.at(-1) ?? 0) + params.earPad) };
    }
    return result;
  }
  const [left, right] = result.wings, p = result.portrait;
  const sourceClearance = result.hub.y - p.sourceBottom, agentOffset = left.H + p.agentTop - p.sourceBottom;
  const anchor = (agentOffset + right.H) / 2;
  const sourceTop = result.vw <= portraitMobileBreakpoint ? 64 : Math.max(portraitInset, result.vh / 2 - anchor);
  const dy = sourceTop - p.sourceTop;
  p.sourceTop += dy; p.sourceBottom += dy; p.agentTop += dy; p.agentBottom += dy;
  result.hub.y = p.sourceBottom + sourceClearance;
  for (const wing of result.wings) { wing.nodes.forEach(n => n.y += dy); }
  result.sceneH = Math.max(result.vh, p.agentBottom + portraitInset);
  return result;
}

export function compactRoots(left: readonly ActivityEntity[], right: readonly ActivityEntity[], viewport: Pick<Scene, 'vw' | 'vh'>, orientation: Orientation, params: Params, solved?: Layout): CompactPlan {
  const scene = { ...viewport, left, right }, plan: CompactPlan = { left: new Set(), right: new Set() };
  const initial = solved ?? (orientation === 'portrait' ? solvePortrait(scene, params) : solve(scene, params));
  const budget = initial.portrait ? viewport.vh - 2 * portraitInset - (initial.portrait.agentTop - initial.portrait.sourceBottom) : viewport.vh - 140;
  let heights = compactLayout(scene, plan, new Set(), params, orientation).wings.map(w => w.H);
  const candidates: { side: Side; parent?: string; depth: number; phase: number; ids: string[]; idle: string[] }[] = [];
  const visit = (list: readonly ActivityEntity[], side: Side, depth: number, parent?: string) => {
    for (const node of list) visit(node.children ?? [], side, depth + 1, node.id);
    const ranked = rank(list), top = parent === undefined ? ranked[0]?.id : undefined;
    const ids = ranked.filter(n => !n.pinned && n.id !== top).reverse().map(n => n.id);
    const idle = ids.filter(id => {
      const hasWork = (n: ActivityEntity): boolean => !!n.attention || !!n.selected || !!n.children?.some(hasWork);
      return !hasWork(list.find(n => n.id === id)!);
    });
    if (parent !== undefined && idle.length >= 2) candidates.push({ side, parent, depth, phase: 0, ids: idle, idle });
    if (ids.length >= 2) candidates.push({ side, parent, depth, phase: parent === undefined ? 1 : 2, ids, idle });
  };
  visit(left, -1, 0); visit(right, 1, 0);
  candidates.sort((a, b) => a.phase - b.phase || b.depth - a.depth || a.side - b.side || (a.parent ?? '').localeCompare(b.parent ?? ''));
  for (const candidate of candidates) {
    const index = candidate.side === -1 ? 0 : 1, hidden = index === 0 ? plan.left : plan.right;
    const height = () => orientation === 'portrait' ? heights[0] + heights[1] : heights[index];
    if (height() <= budget + .001) continue;
    const before = new Set(hidden);
    const batches = [candidate.idle, ...candidate.ids.filter(id => !candidate.idle.includes(id)).map(id => [id])];
    let memberCount = candidate.ids.filter(id => hidden.has(id)).length;
    for (const batch of batches) {
      const remaining = batch.filter(id => !hidden.has(id));
      if (!remaining.length) continue;
      remaining.forEach(id => hidden.add(id)); memberCount += remaining.length;
      if (memberCount < 2) continue;
      const measured = compactLayout(scene, plan, new Set(), params, orientation);
      const next = measured.wings.map(w => w.H);
      if (next[index] < heights[index] - .001) heights = next;
      else { hidden.clear(); before.forEach(id => hidden.add(id)); break; }
      if (height() <= budget + .001) break;
      before.clear(); hidden.forEach(id => before.add(id));
    }
  }
  // Descendant plans covered by a folded ancestor are no longer independent groups.
  const clean = (list: readonly Entity[], hidden: Set<string>, covered = false) => {
    for (const n of list) { const folded = hidden.has(n.id); if (covered) hidden.delete(n.id); clean(n.children ?? [], hidden, covered || folded); }
  };
  clean(left, plan.left); clean(right, plan.right);
  return plan;
}

// An explicitly opened group keeps its original siblings until dismissal.
// The fresh plan takes over again when the user closes it.
export function retainOpenGroup(plan: CompactPlan, left: readonly Entity[], right: readonly Entity[], opened: TopologyGroupPlan | null): CompactPlan {
  if (!opened) return plan;
  const list = opened.side === -1 ? left : right;
  let siblings: readonly Entity[] = list;
  const ancestors: string[] = [];
  const find = (nodes: readonly Entity[], path: string[]): boolean => nodes.some(node => {
    if (node.id === opened.parent) { siblings = node.children ?? []; ancestors.push(...path, node.id); return true; }
    return find(node.children ?? [], [...path, node.id]);
  });
  if (opened.parent && !find(list, [])) return plan;
  const hidden = new Set(opened.side === -1 ? plan.left : plan.right);
  for (const node of siblings) hidden.delete(node.id);
  for (const id of ancestors) hidden.delete(id);
  for (const id of opened.members) if (siblings.some(n => n.id === id)) hidden.add(id);
  return { ...plan, [opened.side === -1 ? 'left' : 'right']: hidden };
}

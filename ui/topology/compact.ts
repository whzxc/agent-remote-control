import { solve, type Entity, type Params, type Scene, type Side, type Task } from './solve.ts';
import { solvePortrait } from './portrait.ts';
import type { Orientation } from './orientation.ts';

export interface ActivityEntity extends Entity {
  tasks: readonly (Task & { state?: string; pending?: boolean; selected?: boolean })[];
  activityAt?: number;
  activityLevel?: number;
  selected?: boolean;
  attention?: boolean;
  children?: ActivityEntity[];
}
export const stackId = (side: Side) => `overflow:${side}`;
function priority(node: ActivityEntity): { level: number; at: number; pinned: boolean } {
  const children = (node.children ?? []).map(priority);
  return {
    level: Math.max(node.activityLevel ?? 0, ...node.tasks.map(task => task.pending || task.state === 'needsYou' ? 3 : task.state === 'running' ? 2 : 0), ...children.map(child => child.level)),
    at: Math.max(node.activityAt ?? 0, ...children.map(child => child.at)),
    pinned: !!node.selected || !!node.attention || node.tasks.some(task => task.selected || task.pending || task.state === 'needsYou') || children.some(child => child.pinned),
  };
}
// Compact only presentation. Keep each wing's busiest root and never move a
// selected node or a pending decision into a hover-only surface.
export function compactRoots(left: ActivityEntity[], right: ActivityEntity[], viewport: Pick<Scene, 'vw' | 'vh'>, orientation: Orientation, params: Params) {
  const hidden = new Set<string>(), lists = [left, right];
  const key = (side: number, id: string) => JSON.stringify([side, id]);
  const rank = (a: ActivityEntity, b: ActivityEntity) => {
    const pa = priority(a), pb = priority(b);
    return pb.level - pa.level || pb.at - pa.at || a.id.localeCompare(b.id);
  };
  const candidates = lists.flatMap((list, index) => {
    const keep = [...list].sort(rank)[0]?.id;
    return list.filter(node => node.id !== keep && !priority(node).pinned).map(node => ({ node, index }));
  }).sort((a, b) => -rank(a.node, b.node) || a.index - b.index);
  const visible = (index: number): Entity[] => {
    const list = lists[index].filter(node => !hidden.has(key(index, node.id)));
    return list.length === lists[index].length ? list : [...list, { id: stackId(index === 0 ? -1 : 1), tasks: [] }];
  };
  const measure = () => {
    const scene = { ...viewport, left: visible(0), right: visible(1) };
    return orientation === 'portrait' ? solvePortrait(scene, params) : solve(scene, params);
  };
  for (const { node, index } of candidates) {
    const layout = measure();
    if (layout.sceneH <= viewport.vh + 1) break;
    const padding = layout.sceneH - Math.max(...layout.wings.map(wing => wing.H));
    if (orientation === 'landscape' && layout.wings[index].H + padding <= viewport.vh + 1) continue;
    hidden.add(key(index, node.id));
  }
  return { left: new Set(left.filter(n => hidden.has(key(0, n.id))).map(n => n.id)),
    right: new Set(right.filter(n => hidden.has(key(1, n.id))).map(n => n.id)) };
}

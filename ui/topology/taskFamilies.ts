import type { PaintTask } from './render';

type Position = Record<string, number>;

// One trunk per parent; phase and relationship type belong to the task bubble.
export function taskFamilyWires(tasks: PaintTask[], read: (task: PaintTask) => Position | undefined, portrait = false) {
  const families = new Map<string, { parent: PaintTask; children: PaintTask[] }>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const parent = tasks.find(row => row.id === task.parentTaskId && row.side === task.side);
    if (!parent) continue;
    const key = JSON.stringify([task.side, parent.id]);
    const family = families.get(key) ?? { parent, children: [] };
    family.children.push(task); families.set(key, family);
  }
  return [...families.values()].flatMap(({ parent, children }) => {
    const root = read(parent);
    if (!root) return [];
    const side = portrait ? -1 : parent.side;
    const x = root.x + ((side === 1 ? 0 : 1) - root.anchor) * root.width + side * 12;
    const y = root.y + root.height / 2;
    const branches = children.flatMap(task => {
      const child = read(task);
      if (!child) return [];
      const end = child.x + ((side === 1 ? 0 : 1) - child.anchor) * child.width;
      return [{ task, y: child.y, opacity: Math.min(root.op, child.op), d: `M${x},${child.y} H${end}` }];
    });
    if (!branches.length) return [];
    const top = Math.min(y, ...branches.map(row => row.y)), bottom = Math.max(y, ...branches.map(row => row.y));
    return [{ parent, branches, opacity: Math.min(root.op, Math.max(...branches.map(row => row.opacity))),
      d: `M${x},${top} V${bottom}` }];
  });
}

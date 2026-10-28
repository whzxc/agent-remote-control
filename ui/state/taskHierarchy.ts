export interface TaskRelation { id: string; parentTaskId?: string }

// Only explicit, present parents create edges. Broken references and cycles
// remain independent roots; titles and dispatch attribution never imply ancestry.
export function taskHierarchy<T extends TaskRelation>(tasks: readonly T[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const parents = new Map<string, string>();
  for (const task of tasks) {
    const seen = new Set([task.id]);
    let parent = task.parentTaskId;
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = byId.get(parent)?.parentTaskId;
    }
    if (parent && seen.has(parent)) continue;
    if (task.parentTaskId && byId.has(task.parentTaskId)) parents.set(task.id, task.parentTaskId);
  }
  const rows: { task: T; depth: number; parentTaskId?: string }[] = [];
  const children = new Map<string | undefined, T[]>();
  for (const task of tasks) {
    const parent = parents.get(task.id);
    children.set(parent, [...children.get(parent) ?? [], task]);
  }
  const visit = (parent: string | undefined, depth: number) => {
    for (const task of children.get(parent) ?? []) {
      rows.push({ task, depth, parentTaskId: parent }); visit(task.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}

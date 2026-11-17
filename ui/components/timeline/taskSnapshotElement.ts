export function taskSnapshotElement(key?: string) {
  return key ? Array.from(document.querySelectorAll<HTMLElement>('[data-task-snapshot]')).find(node => node.dataset.taskSnapshot === key) ?? null : null;
}

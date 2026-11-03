import { createStore } from "./store";
import { reorderActivity, type TrackedActivity } from "./activityModel";

// Task order is a local presentation preference; never send it to the native core.
const key = "arc.task-order";
function read(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].every(id => typeof id === "string")));
  } catch { return {}; }
}
export const taskOrder = createStore(read());
taskOrder.subscribe(() => { try { localStorage.setItem(key, JSON.stringify(taskOrder.get())); } catch { /* Session order still works. */ } });
window.addEventListener("storage", event => { if (event.key === key) taskOrder.set(read()); });
export function reorderTasks(agent: string, ids: string[], sessions: readonly TrackedActivity[], queue: readonly TrackedActivity[] = sessions) {
  const ordered = reorderActivity(sessions, ids, taskOrder.get()[agent] ?? [], queue);
  if (ordered) taskOrder.set(old => ({ ...old, [agent]: ordered }));
}

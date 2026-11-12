import { createStore } from "./store";
import { layers } from "./layers";

export const oauthApproval = createStore<{ id: string } | undefined>(undefined);
export const navigationAttention = createStore<{ title: string; open: () => void }[]>([]);
/** External requests remain actionable attention while a modal task owns focus. */
export function requestExternalNavigation(title: string, open: () => void) {
  if (layers.get().some(layer => layer.kind === "dialog")) navigationAttention.set(old => [...old.filter(item => item.title !== title), { title, open }]);
  else open();
}
export function openNavigationAttention(title: string) {
  const target = navigationAttention.get().find(item => item.title === title);
  if (!target || layers.get().some(layer => layer.kind === "dialog")) return;
  navigationAttention.set(old => old.filter(item => item !== target)); target.open();
}

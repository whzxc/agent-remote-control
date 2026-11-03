import { api } from "../api";
import { createStore, preference } from "./store";
import { t } from "../i18n";
import { isDesktop } from "../platform";
import { idleUpdate, updateActive, type UpdateSnapshot } from "./updateModel";
export const updateObservation = createStore({ observed: false, error: '' });
export const skipped = preference("update-skipped-version", "", value => value, value => value);
export const updates = createStore<{ snapshot: UpdateSnapshot; panelOpen: boolean; requesting: boolean; error: string; message: string }>(
  { snapshot: idleUpdate(), panelOpen: false, requesting: false, error: "", message: "" });
const patch = (next: Partial<ReturnType<typeof updates.get>>) => updates.set(old => ({ ...old, ...next }));
export const available = () => !!updates.get().snapshot.update?.available && updates.get().snapshot.update?.version !== skipped.get();
export const updateVisible = () => available() || updateActive(updates.get().snapshot);
export function acceptUpdateSnapshot(snapshot: UpdateSnapshot) {
  updateObservation.set({ observed: true, error: '' });
  patch({ snapshot });
}
let reading: Promise<void> | undefined;
let mutationGeneration = 0;
export function refreshUpdate() {
  if (reading) return reading;
  const generation = mutationGeneration;
  return reading = api<UpdateSnapshot>("updates").then(snapshot => { if (generation === mutationGeneration) acceptUpdateSnapshot(snapshot); }).catch(error => { updateObservation.set(old => ({ ...old, error: String(error) })); throw error; }).finally(() => { reading = undefined; });
}
export function showUpdate() { patch({ panelOpen: true }); }
export function dismissUpdate() { patch({ panelOpen: false }); }
async function request(action: () => Promise<unknown>) {
  if (updates.get().requesting) return;
  mutationGeneration++;
  patch({ requesting: true, error: "", message: "" });
  try { await action(); await reading; await refreshUpdate(); }
  catch (error) { patch({ error: String(error) }); }
  finally { patch({ requesting: false }); }
}
export async function checkUpdate(manual = true) {
  if (!isDesktop) return;
  if (manual) skipped.set("");
  await request(() => api("updates/check", "POST"));
  if (manual && !updates.get().error && !updates.get().snapshot.update?.available) patch({ message: t("youAreUpToDate") });
}
export async function installUpdate() {
  const offer = updates.get().snapshot.update;
  if (!offer?.version || !offer.ready) return;
  if (updates.get().requesting) return;
  mutationGeneration++;
  patch({ requesting: true, error: "", message: "" });
  try {
    await api("updates/install", "POST", { version: offer.version });
    patch({ snapshot: { ...updates.get().snapshot, phase: 'installing' } });
  } catch (error) { patch({ error: String(error) }); }
  finally { patch({ requesting: false }); }
}
export async function downloadUpdate() {
  const version = updates.get().snapshot.update?.version;
  if (version) await request(() => api("updates/download", "POST", { version }));
}
export const cancelDownload = () => api("updates/cancel", "POST").then(() => refreshUpdate());
export function skipUpdate() { skipped.set(updates.get().snapshot.update?.version ?? ""); dismissUpdate(); }
export function startUpdateChecks() {
  if (!isDesktop) return () => {};
  const refresh = () => { void refreshUpdate().catch(() => {}); };
  refresh();
  const timer = setInterval(refresh, 2000);
  return () => { clearInterval(timer); };
}

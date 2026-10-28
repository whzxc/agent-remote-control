import { api } from "../api";
import { createStore, preference, preferenceStorage } from "./store";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { idleUpdate, mergeUpdateSnapshot, updateActive, updateTerminal, type UpdateSnapshot, type UpdateTiming } from "./updateModel";
export const skipped = preference("update-skipped-version", "", value => value, value => value);
const outcomeSeen = preference("update-outcome-seen", "", value => value, value => value);
export const updates = createStore<{ snapshot: UpdateSnapshot; panelOpen: boolean; requesting: boolean; error: string; message: string; outcome?: UpdateSnapshot }>(
  { snapshot: idleUpdate(), panelOpen: false, requesting: false, error: "", message: "" });
const patch = (next: Partial<ReturnType<typeof updates.get>>) => updates.set(old => ({ ...old, ...next }));
export const available = () => updates.get().snapshot.state === "available" && updates.get().snapshot.source?.version !== skipped.get();
export const updateVisible = () => available() || updateActive(updates.get().snapshot);
export function acceptUpdateSnapshot(next: UpdateSnapshot) {
  const snapshot = mergeUpdateSnapshot(updates.get().snapshot, next);
  patch({ snapshot });
  const outcome = snapshot.recent?.[0] ?? (updateTerminal(snapshot) ? snapshot : undefined);
  if (outcome?.id && updateTerminal(outcome) && `${outcome.id}:${outcome.state}` !== outcomeSeen.get()) {
    outcomeSeen.set(`${outcome.id}:${outcome.state}`);
    patch({ outcome });
  }
}
let reading: Promise<void> | undefined;
let mutationGeneration = 0;
export function refreshUpdate() {
  if (reading) return reading;
  const generation = mutationGeneration;
  return reading = api<UpdateSnapshot>("updates/status").then(snapshot => { if (generation === mutationGeneration) acceptUpdateSnapshot(snapshot); }).finally(() => { reading = undefined; });
}
export function showUpdate() { patch({ panelOpen: true }); }
export function dismissUpdate() { patch({ panelOpen: false }); }
export function dismissOutcome() { patch({ outcome: undefined }); }
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
  if (manual && !updates.get().error && updates.get().snapshot.state === "idle") patch({ message: t("youAreUpToDate") });
}
export async function installUpdate(when: UpdateTiming = "settled") {
  const source = updates.get().snapshot.source;
  if (!source?.version) return;
  // Retain the existing non-macOS post-restart announcement.
  preferenceStorage.setItem("update-announcement", JSON.stringify(source));
  await request(() => api("updates/install", "POST", { version: source.version, when }));
}
export const scheduleUpdate = (action: "now" | "defer" | "cancel", seconds?: number) => request(() => api("updates/request", "POST", { action, id: updates.get().snapshot.id, ...(seconds === undefined ? {} : { seconds }) }));
export const cancelDownload = () => request(() => api("updates/cancel", "POST"));
export function skipUpdate() { skipped.set(updates.get().snapshot.source?.version ?? ""); dismissUpdate(); }
export const openReleaseNotes = () => openUrl("https://github.com/whzxc/agent-remote-control/releases/latest");
export async function submitLocal(path: string, when: UpdateTiming = "settled") {
  await request(async () => {
    const receipt = await api<UpdateSnapshot>("updates/request", "POST", { action: "submit", source: { kind: "local", path }, when });
    acceptUpdateSnapshot(receipt);
    await api("app/replace/ack", "POST", { id: receipt.id });
  });
}
export function retryUpdate(job: UpdateSnapshot) {
  return job.source?.kind === "release" ? checkUpdate().then(() => { showUpdate(); }) : job.paths?.source ? submitLocal(job.paths.source, job.when) : Promise.resolve();
}
export function startUpdateChecks() {
  if (!isDesktop) return () => {};
  let disposed = false;
  void (async () => {
    const saved = preferenceStorage.getItem("update-announcement");
    if (!saved) return;
    try {
      const source = JSON.parse(saved) as UpdateSnapshot["source"];
      const { getVersion } = await import("@tauri-apps/api/app");
      if (!disposed && source?.version === await getVersion() && !navigator.platform.toLowerCase().includes("mac")) patch({ outcome: { ...idleUpdate(), id: `release:${source.version}`, state: "succeeded", source } });
    } finally { preferenceStorage.removeItem("update-announcement"); }
  })().catch(() => {});
  const refresh = () => { if (!updates.get().requesting) void refreshUpdate().catch(() => {}); };
  refresh();
  const timer = setInterval(refresh, 2000);
  return () => { disposed = true; clearInterval(timer); };
}

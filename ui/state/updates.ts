import { api } from "../api";
import { createStore, preference, preferenceStorage } from "./store";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
export type Update = {
  available: boolean;
  version?: string;
  notes?: string;
  date?: string;
  restarting?: boolean;
  ready?: boolean;
};
export const skipped = preference(
  "update-skipped-version",
  "",
  (value) => value,
  (value) => value,
);
export const updates = createStore<{
  update?: Update;
  checking: boolean;
  phase: "idle" | "downloading" | "installing";
  downloaded: number;
  total?: number;
  error: string;
  message: string;
  dialogOpen: boolean;
  announcement?: Update;
}>({
  checking: false,
  phase: "idle",
  downloaded: 0,
  error: "",
  message: "",
  dialogOpen: false,
});
const patch = (next: Partial<ReturnType<typeof updates.get>>) =>
  updates.set((old) => ({ ...old, ...next }));
export const available = () =>
  !!updates.get().update?.available &&
  updates.get().update?.version !== skipped.get();
export const updateVisible = () =>
  available() && !!updates.get().update?.ready;
let dismissedVersion = "",
  directRequested = false;
export function showUpdate() {
  patch({ dialogOpen: true });
}
export function dismissUpdate() {
  if (updates.get().phase !== "idle") return;
  dismissedVersion = updates.get().update?.version || "";
  patch({ dialogOpen: false });
  directRequested = false;
}
export async function checkUpdate(manual = true) {
  if (!isDesktop || updates.get().checking || updates.get().phase !== "idle")
    return;
  patch({ checking: true });
  if (manual) {
    patch({ error: "", message: "" });
    skipped.set("");
  }
  try {
    const update = await api<Update>("updates/check","POST");
    patch({ update, error: "", message: "" });
    preferenceStorage.setItem("update-last-check", String(Date.now()));
    if (available() && !update.ready)
      await transfer(false);
    if (updateVisible() && (manual || update.version !== dismissedVersion))
      showUpdate();
    if (manual && !update.available) patch({ message: t("youAreUpToDate") });
  } catch (e) {
    if (manual)
      patch({
        error: t("updateCheckFailedValueRetryOrVisitThe", { error: String(e) }),
      });
  } finally {
    patch({ checking: false });
  }
}
async function transfer(installing: boolean, direct = false) {
  const update = updates.get().update;
  if (!update?.version || updates.get().phase !== "idle") return;
  patch({
    error: "",
    message: "",
    downloaded: 0,
    total: undefined,
    phase: installing && update.ready ? "installing" : "downloading",
  });
  let off: (() => void) | undefined,
    restarting = false;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    off = await listen<{
      downloaded?: number;
      total?: number;
      phase: "downloading" | "installing";
    }>("update-progress", (e) => patch(e.payload));
    if (installing) {
      if (direct)
        preferenceStorage.setItem("update-announcement", JSON.stringify(update));
      else preferenceStorage.removeItem("update-announcement");
    }
    const result = await api<Update>(installing ? "updates/install" : "updates/download", "POST", { version: update.version });
    if (result.restarting) {
      restarting = true;
      patch({ phase: "installing" });
      return;
    }
    patch({ update: result });
    if (installing) preferenceStorage.removeItem("update-announcement");
    if (!result.available) patch({ message: t("youAreUpToDate") });
  } catch (e) {
    if (installing) {
      preferenceStorage.removeItem("update-announcement");
      patch({ update: { ...update, ready: false } });
    }
    if (direct) showUpdate();
    if (String(e) === "UPDATE_CANCELLED")
      patch({ message: t("downloadCancelledTheCurrentConnectionIsUnchanged") });
    else patch({ error: t("updateFailedValue", { error: String(e) }) });
  } finally {
    off?.();
    if (!restarting) patch({ phase: "idle" });
  }
}
export const installUpdate = () => transfer(updates.get().update?.ready === true, directRequested);
export const installDirect = () => {
  directRequested = true;
  return transfer(true, true);
};
export async function cancelUpdate() {
  try {
    await api("updates/cancel","POST");
  } catch (e) {
    patch({ error: String(e) });
  }
}
export function skipUpdate() {
  if (updates.get().phase !== "idle") return;
  skipped.set(updates.get().update?.version || "");
  dismissUpdate();
}
export async function openDownloads() {
  try {
    await openUrl(
      "https://github.com/whzxc/agent-remote-control/releases/latest",
    );
  } catch (e) {
    patch({ error: t("unableToOpenDownloadsValue", { error: String(e) }) });
  }
}
export function startUpdateChecks() {
  if (!isDesktop) return () => {};
  void (async () => {
    try {
      const saved = preferenceStorage.getItem("update-announcement");
      if (!saved) return;
      const pending = JSON.parse(saved) as Update;
      const { getVersion } = await import("@tauri-apps/api/app");
      if (pending.version === (await getVersion()))
        patch({ announcement: pending });
      preferenceStorage.removeItem("update-announcement");
    } catch {
      preferenceStorage.removeItem("update-announcement");
    }
  })();
  const read = () => void api<{phase?:string; update?:Update; downloaded?:number; total?:number; error?:string}>("updates").then((state) => {
    const phase = state.phase === "downloading" || state.phase === "installing" ? state.phase : "idle";
    patch({phase,checking:state.phase === "checking",...(state.update ? {update:state.update} : {}),...(state.downloaded === undefined ? {} : {downloaded:state.downloaded,total:state.total})});
    if (updateVisible() && updates.get().update?.version !== dismissedVersion) showUpdate();
  }).catch(() => {});
  read();
  const timer = setInterval(read,2000);
  return () => clearInterval(timer);
}

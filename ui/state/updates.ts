import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { createStore, preference, preparePreferences } from "./store";
import { t } from "../i18n";
import { isDesktop } from "../platform";
import { api } from "../api";
import type { PublishedRelease } from "./releaseNotes";

export type UpdateView = {
  phase: 'idle' | 'checking' | 'downloading' | 'installing';
  version?: string;
  currentVersion?: string;
  notes?: string | null;
  notesZh?: string;
  ready: boolean;
  downloaded: number;
  total?: number;
  checked: boolean;
  panelOpen: boolean;
  error: string;
  message: string;
};
export const updates = createStore<UpdateView>({ phase: 'idle', ready: false, downloaded: 0, checked: false, panelOpen: false, error: '', message: '' });
export const skipped = preference("update-skipped-version", "", value => value, value => value);
const lastCheck = preference("update-last-check", 0, Number, String);
const patch = (next: Partial<UpdateView>) => updates.set(old => ({ ...old, ...next }));
export const available = () => !!updates.get().version && updates.get().version !== skipped.get();
export const updateActive = () => updates.get().phase !== 'idle';
export const updateVisible = () => available() || updateActive();
let pending: Update | undefined;
let operation: Promise<void> | undefined;
let history: { expires: number; releases: PublishedRelease[] } | undefined;
let historyRequest: Promise<PublishedRelease[]> | undefined;
export function loadReleaseHistory() {
  if (history && history.expires > Date.now()) return Promise.resolve(history.releases);
  return historyRequest ??= api<PublishedRelease[]>("updates/history").then(releases => {
    if (!Array.isArray(releases)) throw new Error("Invalid release history response");
    history = { expires: Date.now() + 300_000, releases };
    return releases;
  }).finally(() => { historyRequest = undefined; });
}
function perform(work: () => Promise<void>) {
  if (operation) return operation;
  patch({ error: '', message: '' });
  return operation = work().catch(error => { patch({ phase: 'idle', error: String(error) }); }).finally(() => {
    if (updates.get().phase !== 'installing') patch({ phase: 'idle' });
    operation = undefined;
  });
}
export function showUpdate() { patch({ panelOpen: true }); }
export function dismissUpdate() { patch({ panelOpen: false }); }
async function download() {
  if (!pending || updates.get().ready) return;
  patch({ phase: 'downloading', downloaded: 0, total: undefined });
  await pending.download(event => {
    if (event.event === 'Started') patch({ total: event.data.contentLength });
    if (event.event === 'Progress') patch({ downloaded: updates.get().downloaded + event.data.chunkLength });
  });
  patch({ ready: true });
}
export function checkUpdate(manual = true) {
  return perform(async () => {
    if (manual) skipped.set('');
    patch({ phase: 'checking' });
    lastCheck.set(Date.now());
    const old = pending, ready = updates.get().ready;
    pending = undefined;
    patch({ version: undefined, notes: undefined, notesZh: undefined, ready: false, downloaded: 0, total: undefined });
    try {
      const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_update');
      const found = metadata ? new Update(metadata) : undefined;
      if (found && old?.version === found.version && ready) {
        await found.close(); pending = old;
        patch({ ready: true });
      } else { await old?.close(); pending = found; }
      const notesZh = pending?.rawJson?.notes_zh_cn;
      patch({
        currentVersion: pending?.currentVersion ?? updates.get().currentVersion,
        version: pending?.version,
        notes: pending?.body,
        notesZh: typeof notesZh === "string" ? notesZh : undefined,
      });
      if (pending?.version === skipped.get()) { await pending.close(); pending = undefined; }
      else if (pending) await download();
      else if (manual) patch({ message: t('youAreUpToDate') });
    } catch (error) { if (!pending) await old?.close(); throw error; }
    finally { patch({ checked: true }); }
  });
}
export const downloadUpdate = () => perform(download);
export function installUpdate(version = updates.get().version) {
  const update = pending;
  if (!update || update.version !== version || !updates.get().ready) return Promise.resolve();
  return perform(async () => {
    patch({ phase: 'installing' });
    await invoke('prepare_update');
    try { await update.install(); await relaunch(); }
    catch (error) { await invoke('resume_after_update_failure'); throw error; }
  });
}
export function skipUpdate() {
  if (updateActive()) return;
  skipped.set(updates.get().version ?? '');
  void pending?.close(); pending = undefined;
  patch({ panelOpen: false, ready: false });
}
export function startUpdateChecks() {
  if (!isDesktop) return () => {};
  const hour = 3600000;
  let stopped = false;
  const check = () => void preparePreferences().then(async () => {
    if (Date.now() - lastCheck.get() >= hour) await checkUpdate(false);
    patch({ checked: true });
    return Math.max(1000, hour - (Date.now() - lastCheck.get()));
  }).catch(error => { patch({ checked: true, error: String(error) }); return hour; })
    .then(delay => { if (!stopped) timer = setTimeout(check, delay); });
  let timer = setTimeout(check, 5000);
  return () => { stopped = true; clearTimeout(timer); };
}

import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { createStore, preference, preparePreferences } from "./store";
import { t } from "../i18n";
import { isDesktop } from "../platform";

export type UpdateView = {
  phase: 'idle' | 'checking' | 'downloading' | 'installing';
  version?: string;
  notes?: string | null;
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
    patch({ version: undefined, notes: undefined, ready: false, downloaded: 0, total: undefined });
    try {
      const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_update');
      const found = metadata ? new Update(metadata) : undefined;
      if (found && old?.version === found.version && ready) {
        await found.close(); pending = old;
        patch({ ready: true });
      } else { await old?.close(); pending = found; }
      patch({ version: pending?.version, notes: pending?.body });
      if (pending?.version === skipped.get()) { await pending.close(); pending = undefined; }
      else if (pending) await download();
      else if (manual) patch({ message: t('youAreUpToDate') });
    } catch (error) { if (!pending) await old?.close(); throw error; }
    finally { patch({ checked: true }); }
  });
}
export const downloadUpdate = () => perform(download);
export function installUpdate() {
  if (!pending || !updates.get().ready) return Promise.resolve();
  return perform(async () => {
    patch({ phase: 'installing' });
    await invoke('prepare_update');
    try { await pending!.install(); await relaunch(); }
    catch (error) { await invoke('resume_after_update_failure'); throw error; }
  });
}
export function skipUpdate() {
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

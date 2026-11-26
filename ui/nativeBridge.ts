import { isMyGo } from "mygo-runtime";
import * as tauri from "../desktop/renderer-tauri";
import { DesktopService, events } from "./mygo.generated";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isDesktop = isTauri() || isMyGo();

export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri() || !isMyGo()) return tauri.invoke<T>(command, args);
  return DesktopService.command(command, args) as Promise<T>;
}

type Listener<T> = (event: { payload: T }) => void;
export async function listen<T = unknown>(name: string, handle: Listener<T>): Promise<() => void> {
  if (isTauri()) return tauri.listen<T>(name, handle);
  return events.arcDesktop.on(event => {
    if (event.name === name) handle({ payload: event.payload as T });
  });
}

type WindowBridge = {
  isFullscreen(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  theme(): Promise<"light" | "dark" | null>;
  onFocusChanged(handle: Listener<boolean>): Promise<() => void>;
  onThemeChanged(handle: Listener<"light" | "dark">): Promise<() => void>;
  onResized(handle: () => void): Promise<() => void>;
};

export function getCurrentWindow(): WindowBridge {
  if (isTauri()) return tauri.getCurrentWindow();
  return {
    isFullscreen: () => invoke("window_fullscreen"),
    isMinimized: () => invoke("window_minimized"),
    isVisible: () => invoke("window_visible"),
    setFullscreen: value => invoke("window_set_fullscreen", { value }),
    theme: () => invoke("window_theme"),
    onFocusChanged: handle => listen("window:focus", handle),
    onThemeChanged: handle => listen("window:theme", handle),
    onResized: handle => listen("window:resize", handle),
  };
}

export const openExternal = (url: string) => isTauri() ? tauri.openUrl(url) : invoke<void>("open_external", { url });
export const writeText = (text: string) => isTauri() ? tauri.writeText(text) : invoke<void>("clipboard_write", { text });
export const mockIPC = tauri.mockIPC;

type UpdateMetadata = ConstructorParameters<typeof tauri.Update>[0];
export type DesktopUpdate = Pick<tauri.Update, "version" | "currentVersion" | "body" | "rawJson" | "download" | "close"> & {
  install(): Promise<void>;
};

export async function checkNativeUpdate(): Promise<DesktopUpdate | undefined> {
  const metadata = await invoke<UpdateMetadata | null>("check_update");
  if (!metadata) return;
  if (isTauri() || !isMyGo()) {
    const update = new tauri.Update(metadata);
    return {
      version: update.version, currentVersion: update.currentVersion, body: update.body, rawJson: update.rawJson,
      download: onEvent => update.download(onEvent),
      close: () => update.close(),
      async install() {
        await invoke("prepare_update");
        try { await update.install(); await tauri.relaunch(); }
        catch (error) { await invoke("resume_after_update_failure"); throw error; }
      },
    };
  }
  const { rid } = metadata;
  return {
    version: metadata.version, currentVersion: metadata.currentVersion, body: metadata.body, rawJson: metadata.rawJson,
    async download(onEvent) {
      let started = false;
      let previous = 0;
      const off = events.arcUpdateDownload.on(progress => {
        if (progress.rid !== rid) return;
        if (!started) {
          started = true;
          onEvent?.({ event: "Started", data: { contentLength: progress.total || undefined } });
        }
        onEvent?.({ event: "Progress", data: { chunkLength: progress.downloaded - previous } });
        previous = progress.downloaded;
      });
      try { await invoke("download_update", { rid }); }
      finally { off(); }
    },
    close: () => invoke("close_update", { rid }),
    install: () => invoke("install_update", { rid }),
  };
}

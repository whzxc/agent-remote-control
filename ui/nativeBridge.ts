import { isMyGo } from "mygo-runtime";
import { DesktopService, events } from "./mygo.generated";

export const isDesktop = isMyGo();

export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return DesktopService.command(command, args) as Promise<T>;
}

type Listener<T> = (event: { payload: T }) => void;
export async function listen<T = unknown>(name: string, handle: Listener<T>): Promise<() => void> {
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

export const openExternal = (url: string) => invoke<void>("open_external", { url });
export const writeText = (text: string) => invoke<void>("clipboard_write", { text });

type UpdateMetadata = {
  rid: number;
  version: string;
  currentVersion: string;
  body?: string | null;
  rawJson?: Record<string, unknown>;
};

type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } };

export type DesktopUpdate = Omit<UpdateMetadata, "rid"> & {
  download(onEvent?: (event: UpdateDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
  install(): Promise<void>;
};

export async function checkNativeUpdate(): Promise<DesktopUpdate | undefined> {
  const metadata = await invoke<UpdateMetadata | null>("check_update");
  if (!metadata) return;
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

import { createStore, acceptPreferences, preparePreferences, preference } from "./store";
import { api } from "../api";
import { t } from "../i18n";
import { isDesktop, notifyNative } from "../platform";
import type { Ingress, Status } from "./types";
export const connector = createStore<{
  status?: Status;
  busy: string;
  loading: boolean;
  error: string;
  feedback: { text: string; error: boolean };
}>({
  busy: "",
  loading: true,
  error: "",
  feedback: { text: "", error: false },
});
const patch = (next: Partial<ReturnType<typeof connector.get>>) =>
  connector.set((old) => ({ ...old, ...next }));
const sourceOrder = preference<string[]>("arc.source-order", []);
sourceOrder.subscribe(() => patch({}));
export function orderedSources() {
  const order = sourceOrder.get();
  return [...(connector.get().status?.ingresses || [])].sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return Number(b.controlSource === "chatgpt") - Number(a.controlSource === "chatgpt") || a.name.localeCompare(b.name);
  });
}
export function reorderSources(ids: string[]) {
  const current = orderedSources().map(source => source.id);
  const next = ids.filter(id => current.includes(id));
  next.push(...current.filter(id => !next.includes(id)));
  if (next.every((id, index) => id === current[index])) return;
  sourceOrder.set(next);
}
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, error = false) {
  clearTimeout(feedbackTimer);
  patch({ feedback: { text, error } });
  if (text && !error)
    feedbackTimer = setTimeout(
      () => patch({ feedback: { text: "", error: false } }),
      4500,
    );
}
let reading: Promise<void> | undefined;
export function refreshConnector(): Promise<void> {
  if (reading) return reading;
  reading = preparePreferences().then(() => api<Status>("status"))
    .then(accept)
    .catch((e) => {
      patch({ error: String(e), loading: false });
      throw e;
    })
    .finally(() => {
      reading = undefined;
    });
  return reading;
}
function accept(status: Status) {
  acceptPreferences((status as Status & {preferences?:Record<string,string>}).preferences || {});
  const previous = connector.get().status?.core.appServer.state;
  if (
    previous &&
    previous !== "error" &&
    status.core.appServer.state === "error"
  )
    void notifyNative(
      t("localConnectionError"),
      t("checkDiagnosticsInSettings"),
    ).catch(() => {});
  patch({ status, error: "", loading: false });
}
export async function run(label: string, action: () => Promise<unknown>) {
  if (connector.get().busy) return;
  patch({ busy: label });
  try {
    await action();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  } finally {
    patch({ busy: "" });
  }
}
export function startConnector() {
  let stopped = false;
  let stream: EventSource | undefined;
  const read = () => {
    if (!stopped) void refreshConnector().catch(() => {});
  };
  read();
  if (!isDesktop) {
    stream = new EventSource("/api/events");
    stream.addEventListener("snapshot", (event) => {
      try {
        accept(JSON.parse((event as MessageEvent).data));
      } catch {
        read();
      }
    });
    stream.onerror = read;
  }
  const timer = setInterval(() => {
    if (isDesktop || stream?.readyState !== EventSource.OPEN) read();
  }, 2000);
  return () => {
    stopped = true;
    clearInterval(timer);
    stream?.close();
    clearTimeout(feedbackTimer);
  };
}

export function ingressState(entry: Ingress) {
  if (!entry.enabled) return "disabled";
  if (["starting", "stopping"].includes(entry.state)) return "connectingLabel";
  if (entry.error || ["error", "degraded"].includes(entry.state))
    return "connectionError";
  return entry.state === "ready" ? "connected" : "disconnected";
}

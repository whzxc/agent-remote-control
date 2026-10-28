import { createStore, acceptPreferences, preparePreferences, preference } from "./store";
import { api } from "../api";
import { isLocalSource } from "../sourcePresentation";
import { t } from "../i18n";
import { isDesktop, notifyNative } from "../platform";
import type { ControlSource, Ingress, Status } from "./types";
export const connector = createStore<{
  status?: Status;
  sources: ControlSource[];
  sourcesLoaded: boolean;
  busy: string;
  loading: boolean;
  error: string;
  feedback: { text: string; error: boolean; copy?: string };
}>({
  sources: [],
  sourcesLoaded: false,
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
  return connector.get().sources.filter(source => !isLocalSource(source)).sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return Number(b.product === "chatgpt") - Number(a.product === "chatgpt") || a.label.localeCompare(b.label);
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
export function notify(text: string, error = false, copy?: string) {
  clearTimeout(feedbackTimer);
  patch({ feedback: { text, error, copy } });
  if (text && !error)
    feedbackTimer = setTimeout(
      () => patch({ feedback: { text: "", error: false } }),
      copy ? 12000 : 4500,
    );
}
let reading: Promise<void> | undefined;
export function refreshConnector(): Promise<void> {
  if (reading) return reading;
  reading = preparePreferences().then(() => Promise.all([api<Status>("status"), api<{ sources: ControlSource[] }>("source")]))
    .then(([status, result]) => { patch({ sources: result.sources, sourcesLoaded: true }); accept(status); })
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
  let lastSnapshot = 0;
  let stream: EventSource | undefined;
  const read = () => {
    if (!stopped) void refreshConnector().catch(() => {});
  };
  read();
  // Dev previews share an HTTP/1 connection pool across IAB tabs. Use polling
  // so three long-lived streams per preview cannot starve ordinary API reads.
  if (!isDesktop && !import.meta.env.DEV) {
    stream = new EventSource("/api/events");
    stream.addEventListener("snapshot", (event) => {
      try {
        accept(JSON.parse((event as MessageEvent).data));
        lastSnapshot = Date.now();
        read();
      } catch {
        read();
      }
    });
    stream.onerror = () => { lastSnapshot = 0; read(); };
  }
  const timer = setInterval(() => {
    if (isDesktop || stream?.readyState !== EventSource.OPEN || connector.get().error || Date.now() - lastSnapshot > 5000) read();
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

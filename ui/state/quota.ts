import { createStore, preference } from "./store";
import { api } from "../api";
import { isDesktop } from "../platform";
export type Quota = { remaining: number; resetsAt?: string };
export const quotas = createStore<Record<string, Quota | null>>({});
export const maxVisibleAgents = preference<number>('agents-max-visible', 4);
export function startQuota() {
  let stopped = false;
  let off: (() => void) | undefined;
  let stream: EventSource | undefined;
  const read = () => api<Record<string, Quota | null>>("quota").then(value => { if (!stopped) quotas.set(value); }).catch(() => { if (!stopped) quotas.set({}); });
  if (isDesktop) void import("@tauri-apps/api/event").then(async ({ listen }) => {
    const dispose = await listen<Record<string, Quota | null>>("quota:changed", e => quotas.set(e.payload));
    if (stopped) dispose(); else { off = dispose; void read(); }
  });
  else {
    stream = new EventSource("/api/quota/events");
    stream.onerror = () => quotas.set({});
    stream.addEventListener("snapshot", event => quotas.set(JSON.parse((event as MessageEvent).data)));
  }
  return () => { stopped = true; off?.(); stream?.close(); };
}
export const activeAgents = createStore<string[]>([]);
export function startAgentActivity() {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    expires: ReturnType<typeof setTimeout> | undefined;
  async function read() {
    try {
      const result = await api<{ activeAgents: string[] }>("agents/activity");
      if (!stopped) {
        activeAgents.set(result.activeAgents);
        clearTimeout(expires);
        expires = setTimeout(() => activeAgents.set([]), 10000);
      }
    } catch {
      if (!stopped) activeAgents.set([]);
    } finally {
      if (!stopped) timer = setTimeout(read, 2000);
    }
  }
  void read();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(expires);
    activeAgents.set([]);
  };
}

import { apiUrl } from "../browserMode";
import { createStore } from "./store";
import { api } from "../api";
import { isDesktop } from "../platform";
import { presentSubscription } from "../subscriptions/response";
import type { Snapshot, Settings } from "../subscriptions/types";
export const subscriptions = createStore<{
  snapshot?: Snapshot;
  error: string;
}>({ error: "" });
export function platformQuotaForAgent(snapshot: Snapshot | undefined, agent: string) {
  return snapshot?.settings.enabled
    ? snapshot.providers.find(provider => provider.eligible && provider.agentIds.includes(agent))
    : undefined;
}
const retired = new Set<string>();
export function acceptSubscriptions(next: Snapshot | null | undefined) {
  // Core can disappear between the request and snapshot publication.
  if (!next || typeof next.instanceId !== "string" || !Number.isFinite(next.revision)
    || !next.settings || !Array.isArray(next.providers)) return;
  const old = subscriptions.get().snapshot;
  if (
    retired.has(next.instanceId) ||
    (old && old.instanceId === next.instanceId && old.revision > next.revision)
  )
    return;
  if (old && old.instanceId !== next.instanceId) retired.add(old.instanceId);
  subscriptions.set({
    snapshot: { ...next, providers: next.providers.map(presentSubscription) },
    error: "",
  });
}
export async function readSubscriptions() {
  const before = subscriptions.get().snapshot;
  try {
    acceptSubscriptions(await api<Snapshot>("subscriptions"));
  } catch (e) {
    if (subscriptions.get().snapshot === before)
      subscriptions.set({
        error: String(e),
        snapshot: before
          ? {
              ...before,
              providers: before.providers.map((p) => ({
                ...p,
                state: p.state === "ready" ? "stale" : p.state,
                refreshing: false,
              })),
            }
          : undefined,
      });
  }
}
export async function refreshSubscription(providerId: string) {
  await api("subscriptions/refresh", "POST", { providerId });
  acceptSubscriptions(await api<Snapshot>("subscriptions"));
}
export async function saveSubscriptions(patch: Partial<Settings>) {
  const snapshot = subscriptions.get().snapshot;
  if (!snapshot) throw new Error("Subscription settings unavailable");
  acceptSubscriptions(
    await api<Snapshot>("subscriptions/settings", "PUT", {
      ...snapshot.settings,
      ...patch,
    }),
  );
}
export function startSubscriptions() {
  let stopped = false,
    off: (() => void) | undefined,
    stream: EventSource | undefined;
  if (isDesktop)
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const dispose = await listen<Snapshot>("subscriptions:changed", (e) =>
          acceptSubscriptions(e.payload),
        );
        if (stopped) dispose();
        else off = dispose;
      })
      .catch((e) => subscriptions.set((old) => ({ ...old, error: String(e) })));
  else if (!import.meta.env.DEV) {
    stream = new EventSource(apiUrl("subscriptions/events"));
    stream.addEventListener("snapshot", (event) => {
      try {
        acceptSubscriptions(JSON.parse((event as MessageEvent).data));
      } catch {
        void readSubscriptions();
      }
    });
    stream.onerror = () => void readSubscriptions();
  }
  void readSubscriptions();
  const timer = setInterval(() => {
    if (!document.hidden && (!stream || stream.readyState !== EventSource.OPEN))
      void readSubscriptions();
  }, 30000);
  return () => {
    stopped = true;
    off?.();
    stream?.close();
    clearInterval(timer);
  };
}

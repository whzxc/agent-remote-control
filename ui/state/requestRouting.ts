import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isTaskId } from "./taskProjection";
import type { AgentInteraction } from "../types";

export interface RequestRouting {
  state: "deferred" | "paused" | "routed" | "not-routable";
  deferUntil: number | null;
  pausedBy: string | null;
  reason: string;
}
let presenceWrites = Promise.resolve();
export function useTaskPresence(agent: string, taskId: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !isTaskId(taskId)) return;
    // Serial requests keep blur/close from being overtaken by an earlier heartbeat.
    const send = (present: boolean) => {
      presenceWrites = presenceWrites.then(() => api("tasks/presence", "POST", { agent, taskId, present })).then(() => {}, () => {});
    };
    const update = () => send(document.visibilityState === "visible" && document.hasFocus());
    update();
    const timer = setInterval(update, 2000);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      send(false);
    };
  }, [agent, taskId, enabled]);
}
export function useRequestRouting(agent: string, taskId: string, interaction?: AgentInteraction) {
  const args = interaction?.respond.args;
  const nativeId = args?.id ?? args?.interactionId;
  const id = nativeId === undefined ? undefined : String(nativeId);
  const [routing, setRouting] = useState<RequestRouting>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const pending = useRef(false);
  const identity = `${agent}:${taskId}:${id}`;
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    setRouting(undefined); setError(""); setBusy(false); pending.current = false;
    if (id === undefined || !isTaskId(taskId)) return;
    let stopped = false;
    const read = async () => {
      if (pending.current) return;
      const generation = version.current;
      try {
        const result = await api<{ routing: RequestRouting }>("tasks/request-routing", "POST", { agent, taskId, id, action: "read" });
        if (!stopped && generation === version.current) { setRouting(result.routing); setError(""); }
      } catch (e) {
        if (!stopped && generation === version.current) setError(String(e));
      }
    };
    void read();
    const timer = setInterval(read, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [agent, taskId, id]);
  const change = async (action: "pause" | "resume" | "handoff") => {
    if (id === undefined || !isTaskId(taskId) || pending.current || action === "pause" && routing && routing.state !== "deferred") return;
    pending.current = true; version.current++; setBusy(true);
    try {
      const result = await api<{ routing: RequestRouting }>("tasks/request-routing", "POST", { agent, taskId, id, action });
      if (current.current === identity) { setRouting(result.routing); setError(""); }
    } catch (e) { if (current.current === identity) setError(String(e)); }
    finally { if (current.current === identity) { pending.current = false; setBusy(false); } }
  };
  return { routing, error, busy, change };
}

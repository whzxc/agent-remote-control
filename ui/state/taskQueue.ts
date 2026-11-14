import { useEffect, useState } from "react";
import { api } from "../api";
import { isTaskId } from "./taskProjection";
export interface QueuedMessage { origin?: {sourceId?: string; controlSource?: string; sourceLabel?: string}; controlSource?: import("../types").DispatchSummary["controlSource"]; queueId: string; threadId: string; preview: string; text?: string; state: string; reason?: string; error?: unknown; }
export function useTaskQueue(agent: string, id: string) {
  const [items, setItems] = useState<QueuedMessage[]>([]), [error, setError] = useState("");
  const read = async () => {
    const result = await api<{ items: QueuedMessage[] }>("tasks/control", "POST", { op: "codex_queue", args: { threadId: id } });
    return result.items.map(row => ({ ...row, controlSource: row.origin?.sourceId ? {
      id: row.origin.sourceId, kind: row.origin.controlSource, label: row.origin.sourceLabel,
    } : undefined }));
  };
  useEffect(() => {
    setItems([]); setError("");
    if (agent !== "codex" || !isTaskId(id)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await read(); if (!stopped) { setItems(next); setError(""); } }
      catch (e) { if (!stopped) setError(String(e)); }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agent, id]);
  return { items, error };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { preference } from "./store";
export const relayHostingEnabled = preference("arc.relay-hosting", false, raw => JSON.parse(raw) === true);
export type Relay = { id: string; url: string; name: string; owner: boolean; ingressId: string; workerVersion: string | null };
export type RelayProgress = { phase: "idle" | "login" | "deploying" | "connecting" | "ready" | "failed"; jobId?: string; action?: string; relayId?: string; ingressId?: string; loginUrl?: string; reason?: string; cancelled?: boolean; failedPhase?: string; accounts?: { id: string; name: string }[]; result?: { relayId?: string; ingressId?: string; url?: string; deleted?: boolean } };
export function useRelays() {
  const [data, setData] = useState<{ relays: Relay[]; version: string }>({ relays: [], version: "" });
  const [error, setError] = useState(""), [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try { const value = await api<typeof data>("relay/list"); setData(value); setError(""); return value; }
    catch (e) { setError(String(e)); throw e; }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  return { ...data, error, loaded, refresh };
}
export function useRelayProgress(active: boolean, onReady: (value: RelayProgress) => void) {
  const [progress, updateProgress] = useState<RelayProgress>({ phase: "idle" });
  const [error, setError] = useState("");
  const expectedJob = useRef<string>(undefined), ready = useRef(onReady);
  ready.current = onReady;
  const setProgress = useCallback((value: RelayProgress) => { expectedJob.current = value.jobId; updateProgress(value); }, []);
  useEffect(() => {
    if (!active) return;
    let stopped = false, reading = false, completed = false;
    const read = async () => {
      if (stopped || reading || completed) return;
      reading = true;
      try {
        const value = await api<RelayProgress>("relay/progress");
        if (stopped || expectedJob.current && value.jobId !== expectedJob.current) return;
        updateProgress(value); setError("");
        if (value.phase === "ready") { completed = true; ready.current(value); }
        if (value.phase === "failed") completed = true;
      } catch (e) { if (!stopped) setError(String(e)); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, progress.jobId]);
  return { progress, setProgress, error };
}

import { trackedActivity, resetActivityBubbles, observeActivityTurn, restoreActivityReads, rememberActivityRead, controlActivityBubble } from "./activityBubbles";
import { resetTaskExecutions, refreshTaskExecution } from "./taskExecution";
import { taskState } from "./taskProjection";
import { terminalState } from "./taskExecutionModel";
import { agentPanel } from "./overviewPanels";
import { useEffect, useRef } from "react";
import { createStore } from "./store";
import { api } from "../api";
import { isDesktop } from "../platform";
import type { AgentActivitySession, AgentActivitySnapshot } from "../types";
import { trackActivity, activityLayout, beginApproval, finishApproval, interactionKey, mergeActivity, permissionResponse, type ApprovalDecision, type ApprovalSubmission } from "./activityModel";

export const agentActivity = createStore<{ snapshot?: AgentActivitySnapshot; error: string }>({ error: "" });

let activityCore: string | undefined;
export function resetActivityCore(core: string) {
  if (activityCore && activityCore !== core) {
    agentActivity.set({ error: "" });
    resetActivityBubbles();
    resetTaskExecutions();
  }
  activityCore = core;
}
export const activityApprovals = createStore<Record<string, ApprovalSubmission>>({});
export function acceptActivity(snapshot: AgentActivitySnapshot) {
  const next = mergeActivity(agentActivity.get().snapshot, snapshot);
  if (next !== snapshot) return;
  const selected = agentPanel.get();
  trackedActivity.set(old => Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(snapshot.agents)])]
    .map(agent => {
      const previous = old[agent] ?? [], live = snapshot.agents[agent]?.sessions ?? [];
      for (const session of live) observeActivityTurn(agent, session, previous.find(row => row.id === session.id));
      const now = Date.now(), pinnedId = selected?.agent === agent ? selected.session?.id : undefined;
      return [agent, restoreActivityReads(agent, trackActivity(previous, live, now, pinnedId), now, pinnedId)];
    })));
  agentActivity.set({ snapshot: next, error: "" });
  const missing = Object.entries(trackedActivity.get()).flatMap(([agent, sessions]) => sessions
    .filter(session => session.observed === false && !terminalState(taskState(session.status ?? undefined, false)))
    .map(session => [agent, session.id] as const));
  void (async () => {
    for (let i = 0; i < missing.length; i += 4) await Promise.all(missing.slice(i, i + 4).map(([agent, id]) => refreshTaskExecution(agent, id).catch(() => {})));
  })();
  const keys = new Set(Object.entries(next.agents).flatMap(([agent, value]) => value.sessions
    .filter(session => session.interaction).map(session => interactionKey(agent, session))));
  const retained = agentPanel.get();
  activityApprovals.set(old => Object.fromEntries(Object.entries(old).filter(([key]) => {
    const [agent, id] = JSON.parse(key);
    return keys.has(key) || (retained && retained.agent === agent && retained.session?.id === id);
  })));
}
export function startAgentActivity() {
  let stopped = false, connected = false, reading = false, generation = 0;
  let off: (() => void) | undefined, stream: EventSource | undefined;
  const accept = (snapshot: AgentActivitySnapshot) => {
    if (stopped) return;
    generation++;
    acceptActivity(snapshot);
  };
  async function read() {
    if (stopped || reading) return;
    reading = true;
    const before = generation;
    try {
      const snapshot = await api<AgentActivitySnapshot>("agents/activity");
      if (!stopped && before === generation) accept(snapshot);
    } catch (error) {
      if (!stopped && before === generation) agentActivity.set(old => ({ ...old, error: String(error) }));
    } finally { reading = false; }
  }
  if (isDesktop) {
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const dispose = await listen<AgentActivitySnapshot>("agents:activity", event => accept(event.payload));
      if (stopped) dispose();
      else { off = dispose; connected = true; void read(); }
    }).catch(() => { connected = false; void read(); });
  } else if (!import.meta.env.DEV && typeof EventSource !== "undefined") {
    stream = new EventSource("/api/agents/activity/events");
    stream.onopen = () => { connected = true; };
    stream.addEventListener("snapshot", event => {
      try { accept(JSON.parse((event as MessageEvent).data)); }
      catch { void read(); }
    });
    stream.onerror = () => { connected = false; void read(); };
  }
  void read();
  const timer = setInterval(() => { if (!document.hidden && !connected) void read(); }, import.meta.env.DEV ? 2000 : 5000);
  const resume = () => { if (!document.hidden) void read(); };
  document.addEventListener("visibilitychange", resume);
  return () => {
    stopped = true;
    off?.(); stream?.close(); clearInterval(timer);
    document.removeEventListener("visibilitychange", resume);
  };
}
export async function submitActivityApproval(agent: string, session: AgentActivitySession, decision: "allow" | "deny") {
  if (!session.interaction) return;
  const payload = permissionResponse(session.interaction, decision);
  if (!payload) return;
  return submitActivityResponse(agent, session, decision, payload);
}
export async function submitActivityResponse(agent: string, session: AgentActivitySession, decision: ApprovalDecision,
  payload: import("./activityModel").ApprovalPayload) {
  if (session.source === "transcript") return;
  const key = interactionKey(agent, session);
  const submission = beginApproval(activityApprovals.get()[key], decision, payload, () => crypto.randomUUID());
  if (!submission) return;
  activityApprovals.set(old => ({ ...old, [key]: submission }));
  const finish = (next: ApprovalSubmission) => activityApprovals.set(old => old[key] === submission ? { ...old, [key]: next } : old);
  try {
    finish(finishApproval(submission, await api("agents/respond", "POST", submission.payload)));
  } catch (error) { finish({ ...submission, status: "failed", error: String(error) }); }
}
export async function openAgentTask(agent: string, taskId: string) {
  await api("tasks/open", "POST", { agent, taskId });
}
// Native navigation is only exposed by the detail header.
export async function openActivitySession(agent: string, session: AgentActivitySession) {
  if (session.open) await openAgentTask(agent, session.open.taskId);
}

// Renderer-scoped geometry with durable completion read acknowledgements.
export function useActivityTracking() {
  const selected = agentPanel.use(), previousSelection = useRef(selected);
  const tracked = trackedActivity.use(), setTracked = trackedActivity.set;
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selected;
    // Opening reads a completion; closing starts its dismissal delay without
    // changing the actual completion time or removing the focus origin early.
    setTracked(old => Object.fromEntries(Object.entries(old).map(([agent, sessions]) => [agent, sessions.map(session => {
      if (session.endedAt === undefined || !((selected?.agent === agent && selected.session?.id === session.id)
        || (previous?.agent === agent && previous.session?.id === session.id))) return session;
      const readAt = Date.now();
      rememberActivityRead(agent, session, readAt);
      return { ...session, readAt };
    })])));
  }, [selected]);
  useEffect(() => {
    const pinned = (agent: string, id: string) => selected?.agent === agent && selected.session?.id === id;
    const ends = Object.entries(tracked).flatMap(([agent, sessions]) => sessions.flatMap(s => s.endedAt === undefined || s.readAt === undefined || pinned(agent, s.id) ? [] : [s.readAt + activityLayout.hold + activityLayout.fade]));
    if (!ends.length) return;
    const timer = setTimeout(() => setTracked(old => Object.fromEntries(Object.entries(old).map(([agent, sessions]) =>
      [agent, sessions.filter(s => s.endedAt === undefined || s.readAt === undefined || pinned(agent, s.id) || Date.now() < s.readAt + activityLayout.hold + activityLayout.fade)]))),
      Math.max(0, Math.min(...ends) - Date.now()));
    return () => clearTimeout(timer);
  }, [tracked, selected]);
  function markRead(agent: string, id: string) {
    controlActivityBubble({ agent, id, action: "mark-read" });
  }
  return { tracked, markRead };
}

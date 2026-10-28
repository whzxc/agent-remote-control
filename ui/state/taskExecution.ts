import { useEffect } from "react";
import { api } from "../api";
import type { AgentTimeline } from "../types";
import { createStore } from "./store";
import { trackedActivity, rememberActivityRead } from "./activityBubbles";
import { agentPanel } from "./overviewPanels";
import { taskState } from "./taskProjection";
import { executionSnapshot, executionStatus, terminalState, type TaskExecution } from "./taskExecutionModel";

const key = (agent: string, id: string) => JSON.stringify([agent, id]);
export const taskExecutions = createStore<Record<string, TaskExecution>>({});
const reads = new Map<string, Promise<void>>();
const lastRead = new Map<string, number>();
let generation = 0;
export function resetTaskExecutions() { generation++; taskExecutions.set({}); lastRead.clear(); reads.clear(); }
export function taskExecution(agent: string, id: string) { return taskExecutions.get()[key(agent, id)]; }
export function acceptTaskExecution(agent: string, id: string, timeline: AgentTimeline) {
  const execution = executionSnapshot(timeline);
  if (JSON.stringify(taskExecution(agent, id)) !== JSON.stringify(execution)) taskExecutions.set(old => ({ ...old, [key(agent, id)]: execution }));
  trackedActivity.set(old => ({ ...old, [agent]: (old[agent] ?? []).map(session => {
    if (session.id !== id || session.observed !== false) return session;
    const status = executionStatus(execution, session.turnId);
    if (!terminalState(taskState(status, false))) return session;
    const nativeEnd = Date.parse(execution.turnTimings?.[session.turnId ?? execution.turnId ?? ""]?.endedAt ?? "");
    const selected = agentPanel.get(), readAt = selected?.agent === agent && selected.session?.id === id ? Date.now() : session.readAt;
    const next = { ...session, status, endedAt: Number.isFinite(nativeEnd) ? nativeEnd : session.endedAt ?? Date.now(), ...(readAt === undefined ? {} : { readAt }) };
    if (readAt !== undefined) rememberActivityRead(agent, next, readAt);
    return next;
  }) }));
}
export function refreshTaskExecution(agent: string, id: string): Promise<void> {
  const identity = key(agent, id), pending = reads.get(identity);
  if (pending) return pending;
  if (performance.now() - (lastRead.get(identity) ?? -Infinity) < 10000) return Promise.resolve();
  lastRead.set(identity, performance.now());
  const started = generation;
  const read = api<AgentTimeline>("agents/conversations/timeline", "POST", { agent, id })
    .then(timeline => { if (started === generation) acceptTaskExecution(agent, id, timeline); })
    .finally(() => { if (reads.get(identity) === read) reads.delete(identity); });
  reads.set(identity, read); return read;
}
export function useTaskExecution(agent: string, id: string, turnId: string | null | undefined, enabled: boolean) {
  const execution = taskExecutions.use()[key(agent, id)];
  const terminal = terminalState(taskState(executionStatus(execution, turnId), false));
  useEffect(() => {
    if (!enabled || !agent || terminal) return;
    const read = () => { void refreshTaskExecution(agent, id).catch(() => {}); };
    read(); const timer = setInterval(read, 10000);
    return () => clearInterval(timer);
  }, [agent, id, turnId, enabled, terminal]);
  return execution;
}

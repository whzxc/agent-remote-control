import type { AgentActivitySession, AgentTimeline, AgentTimelineEntry } from "../types.ts";
import { taskState, type TaskState } from "./taskProjection.ts";

export interface TaskExecution extends Pick<AgentTimeline, "status" | "turnStatuses" | "turnTimings" | "readOnly"> {
  turnId?: string;
  interactions: AgentTimelineEntry[];
}
export function executionSnapshot(timeline: AgentTimeline): TaskExecution {
  return { status: timeline.status, turnId: timeline.entries.at(-1)?.turnId || undefined,
    turnStatuses: timeline.turnStatuses, turnTimings: timeline.turnTimings, readOnly: timeline.readOnly,
    interactions: timeline.entries.filter(entry => entry.type === "interaction") };
}
export function executionStatus(execution: TaskExecution | undefined, turnId?: string | null) {
  return turnId ? execution?.turnStatuses?.[turnId] ?? (execution?.turnId === turnId ? execution.status : undefined) : execution?.status;
}
export function terminalState(state: TaskState) {
  return state === "done" || state === "failed" || state === "interrupted";
}
export function activityState(session: AgentActivitySession & { observed?: boolean; endedAt?: number; status?: string | null }, execution?: TaskExecution, pending = !!session.interaction, live = session.observed !== false && session.endedAt === undefined) {
  return taskState(executionStatus(execution, session.turnId) ?? session.status ?? undefined, live, pending);
}
export function executionPhase(phase: AgentActivitySession["phase"], state: TaskState) {
  return state === "running" && phase !== "interaction" && phase !== "idle" ? phase : undefined;
}

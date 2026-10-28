import type { AgentActivitySession } from "../types";
import type { TaskRecord } from "./tasks";
import { taskState } from "./taskProjection.ts";
import { executionStatus, type TaskExecution } from "./taskExecutionModel.ts";

export function sourceDispatches(records: TaskRecord[], sourceId: string) {
  return records.filter(r => (r.origin?.sourceId ?? r.task.origin?.sourceId) === sourceId && ["create", "send"].includes(r.task.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function dispatchTaskId(record: TaskRecord) {
  return record.taskId || record.threadId || record.task.threadId;
}
export function dispatchState(record: TaskRecord, execution: TaskExecution | undefined, session: AgentActivitySession | undefined, pending = !!session?.interaction) {
  const matching = !!record.turnId && session?.turnId === record.turnId;
  const status = record.turnId ? executionStatus(execution, record.turnId) : undefined;
  if (matching || status && taskState(status, false) !== "unknown") return taskState(status, matching, matching && pending);
  if (record.state === "awaiting-approval") return "awaitingApproval";
  if (["rejected", "not-executed", "cancelled"].includes(record.state)) return "notExecuted";
  if (record.state === "unconfirmed") return "submissionUnknown";
  if (record.error || record.state === "failed") return "submissionFailed";
  if (["pending", "reserved", "submitting", "thread-submitting", "thread-created", "turn-submitting"].includes(record.state)) return "submitting";
  return "unknown";
}

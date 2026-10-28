import type { AgentTimelineEntry } from "../types.ts";
import { turnEntries, workState } from "./timelineGroups.ts";

export type TaskState = "running" | "needsYou" | "done" | "failed" | "interrupted" | "unknown";
export function isTaskId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}
export function taskState(status: string | undefined, live: boolean, pending = false): TaskState {
  if (pending && live) return "needsYou";
  if (live) return "running";
  if (["failed", "error"].includes(status ?? "")) return "failed";
  if (["cancelled", "interrupted", "canceled", "aborted"].includes(status ?? "")) return "interrupted";
  if (status === "completed") return "done";
  return "unknown";
}
export type ProcessRow = { kind: "tools"; id: string; entries: AgentTimelineEntry[] } | { kind: "entry"; id: string; entry: AgentTimelineEntry };
export function processRows(entries: readonly AgentTimelineEntry[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const plan = [...entries].reverse().find(entry => entry.type === "plan");
  let insertedPlan = false;
  for (const entry of entries) {
    if (entry.type === "thinking" || entry.type === "notice") continue;
    if (entry.type === "plan") {
      if (!insertedPlan && plan) rows.push({ kind: "entry", id: entry.id, entry: plan });
      insertedPlan = true;
      continue;
    }
    if (["command", "file", "tool"].includes(entry.type)) {
      const last = rows.at(-1);
      if (last?.kind === "tools") last.entries.push(entry);
      else rows.push({ kind: "tools", id: entry.id, entries: [entry] });
    } else rows.push({ kind: "entry", id: entry.id, entry });
  }
  return rows;
}
export function processOpen(state: TaskState, manual?: boolean) {
  return state === "needsYou" || (manual ?? ["running", "failed", "interrupted"].includes(state));
}
export function projectTurn(entries: readonly AgentTimelineEntry[], state: TaskState) {
  const live = state === "running" || state === "needsYou";
  const { prompt, final, work } = turnEntries(entries, live, state === "done");
  const answeredInteractions = work.filter(entry => entry.type === "interaction" && (entry.status === "completed" || !!entry.response));
  const rows = processRows(work.filter(entry => !answeredInteractions.includes(entry)));
  return { prompt, final, rows, answeredInteractions, plan: [...entries].reverse().find(entry => entry.type === "plan"),
    thinking: live ? [...entries].reverse().find(entry => entry.type === "thinking" && entry.text?.trim()) : undefined,
    updates: work.filter(entry => entry.type === "text").length,
    answers: work.filter(entry => entry.type === "interaction" && entry.status === "completed").length,
    actions: work.filter(entry => ["command", "file", "tool"].includes(entry.type)).length,
  };
}
export function toolCounts(entries: readonly AgentTimelineEntry[], live = true) {
  const counts = workState(entries).counts;
  const actions = entries.flatMap(entry => entry.commandActions ?? []);
  const reads = new Set(actions.filter(action => action.type === "read" && action.path).map(action => action.path));
  const commands = entries.filter(entry => entry.type === "command" && (!entry.commandActions?.length || entry.commandActions.some(action => !["read", "search", "listFiles"].includes(action.type))));
  const running = live ? commands.filter(entry => entry.status === "running").length : 0;
  return { read: counts.read + reads.size, search: actions.filter(action => action.type === "search").length,
    list: actions.filter(action => action.type === "listFiles").length,
    edit: counts.write, file: counts.file, command: commands.length - running, running, tool: counts.tool };
}
export function changedFiles(entries: readonly AgentTimelineEntry[]) {
  const files = new Map<string, { path: string; operation?: "create" | "edit" | "delete"; added?: number; removed?: number }>();
  for (const entry of entries) {
    if (entry.status !== "completed" || entry.operation === "read") continue;
    const changes: NonNullable<AgentTimelineEntry["changes"]> = entry.changes ?? (entry.type === "file" && entry.path && entry.operation ? [{ path: entry.path, operation: entry.operation === "create" || entry.operation === "delete" ? entry.operation : undefined }] : []);
    for (const change of changes) {
      const previous = files.get(change.path);
      const operation = change.operation === "edit" && previous?.operation === "create" ? "create" : change.operation ?? previous?.operation;
      files.set(change.path, { path: change.path, ...(operation ? { operation } : {}),
        added: change.added === undefined || previous && previous.added === undefined ? undefined : (previous?.added ?? 0) + change.added,
        removed: change.removed === undefined || previous && previous.removed === undefined ? undefined : (previous?.removed ?? 0) + change.removed });
    }
  }
  return [...files.values()];
}

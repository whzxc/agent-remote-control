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
  for (const entry of entries) {
    if (entry.type === "notice" || entry.type === "plan" || entry.type === "thinking" && !(entry.text || entry.title)?.trim()) continue;
    if (["command", "file", "tool"].includes(entry.type)) {
      const last = rows.at(-1);
      if (last?.kind === "tools" && entry.status !== "failed" && !last.entries.some(row => row.status === "failed")) last.entries.push(entry);
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
  // Live tools move to the activity row so the current action is never buried in a group.
  const activity = state === "running" ? liveActivity(work) : undefined;
  // The terminal error is presented once in the outcome card; failed tools stay on the rail.
  const outcome = state === "failed" ? [...work].reverse().find(entry => entry.type === "error" || entry.status === "failed") : undefined;
  const rows = processRows(work.filter(entry => !activity?.running.includes(entry) && !(entry === outcome && entry.type === "error")));
  return { prompt, final, rows, activity, plan: [...entries].reverse().find(entry => entry.type === "plan"),
    actions: work.filter(entry => ["command", "file", "tool"].includes(entry.type)).length,
    failed: work.filter(entry => ["command", "file", "tool"].includes(entry.type) && entry.status === "failed").length,
  };
}
// The current action of a live turn: running tools, or the newest reasoning since the agent last spoke.
export function liveActivity(entries: readonly AgentTimelineEntry[]) {
  const running = entries.filter(entry => ["command", "file", "tool"].includes(entry.type) && (entry.status === "running" || entry.status === "pending"));
  const spoken = [...entries].reverse().findIndex(entry => ["user", "text", "interaction", "error"].includes(entry.type));
  const since = spoken < 0 ? entries : entries.slice(entries.length - spoken);
  const reasoning = [...since].reverse().find(entry => entry.type === "thinking" && entry.text?.trim());
  return { running, thought: reasoning?.text ? thoughtLine(reasoning.text) : undefined };
}
// Reasoning summaries open with a bold heading; otherwise use the first sentence as plain text.
export function thoughtLine(markdown: string) {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s|$)|[。？！]/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
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
const summaryPriority = { edit: 0, command: 0, read: 1, search: 1, list: 1, file: 2, tool: 2 } as const;
export type ToolSummaryKind = keyof typeof summaryPriority;
function toolSummaryKind(entry: AgentTimelineEntry): ToolSummaryKind | undefined {
  if (entry.type === "file") return entry.operation === "read" ? "read" : entry.operation ? "edit" : "file";
  if (entry.type === "tool") return "tool";
  if (entry.type !== "command") return;
  const actions = entry.commandActions ?? [];
  if (!actions.length || actions.some(action => !["read", "search", "listFiles"].includes(action.type))) return "command";
  return actions[0].type === "listFiles" ? "list" : actions[0].type as "read" | "search";
}
// One-line group summary: up to three kinds, otherwise the two most significant plus the remainder, and failures.
export function toolSummary(entries: readonly AgentTimelineEntry[]) {
  const counts = toolCounts(entries, false);
  const firstSeen = new Map<ToolSummaryKind, number>();
  entries.forEach((entry, index) => { const kind = toolSummaryKind(entry); if (kind && !firstSeen.has(kind)) firstSeen.set(kind, index); });
  const kinds = (Object.keys(summaryPriority) as ToolSummaryKind[]).filter(kind => counts[kind] > 0)
    .sort((a, b) => summaryPriority[a] - summaryPriority[b] || (firstSeen.get(a) ?? Infinity) - (firstSeen.get(b) ?? Infinity));
  const shown = kinds.length > 3 ? 2 : kinds.length;
  const parts = kinds.slice(0, shown).sort((a, b) => (firstSeen.get(a) ?? Infinity) - (firstSeen.get(b) ?? Infinity)).map(kind => ({ kind, count: counts[kind] }));
  return { parts, more: kinds.slice(shown).reduce((sum, kind) => sum + counts[kind], 0),
    failed: entries.filter(entry => entry.status === "failed").length };
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

export type TaskStepKind = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting' | 'tool';
export type TaskCardStep = { kind: TaskStepKind; text: string; status: AgentTimelineEntry['status']; durationMs?: number };
export function taskStepKind(entry: AgentTimelineEntry): TaskStepKind | undefined {
  if (entry.type === 'file') return entry.operation === 'read' ? 'reading' : 'editing';
  if (entry.type === 'command') return entry.commandActions?.length && entry.commandActions.every(action => ['read', 'search', 'listFiles'].includes(action.type)) ? 'reading' : 'command';
  if (entry.type === 'thinking') return 'thinking';
  if (entry.status === 'pending' && (entry.type === 'interaction' || entry.type === 'tool')) return 'waiting';
  if (entry.type === 'tool') return 'tool';
}
export function taskCardActivity(entries: readonly AgentTimelineEntry[]) {
  const tail = entries.slice(-80);
  const steps = tail.flatMap<TaskCardStep>(entry => {
    const kind = taskStepKind(entry), text = entry.title || entry.command || entry.path || entry.text || entry.input?.text;
    return kind && text ? [{ kind, text, status: entry.status, durationMs: entry.durationMs }] : [];
  }).slice(-5);
  const planItems = [...tail].reverse().find(entry => entry.type === 'plan')?.plan;
  const plan = planItems?.length ? { total: planItems.length, completed: planItems.filter(item => item.status === 'completed').length,
    current: (planItems.find(item => item.status === 'in_progress' || item.status === 'running') ?? planItems.find(item => item.status !== 'completed'))?.content.text } : undefined;
  const latest = [...tail].reverse().find(entry => entry.changes?.length || entry.path || entry.command);
  const changes = latest?.changes;
  const change = latest ? { kind: latest.command ? 'command' as const : changes?.length ? 'diff' as const : 'file' as const,
    summary: latest.command || latest.path || changes?.map(change => change.path).join(', ') || '',
    added: changes?.some(change => change.added !== undefined) ? changes.reduce((sum, change) => sum + (change.added ?? 0), 0) : undefined,
    removed: changes?.some(change => change.removed !== undefined) ? changes.reduce((sum, change) => sum + (change.removed ?? 0), 0) : undefined,
    output: latest.output?.text, exitCode: latest.exitCode } : undefined;
  const snapshot = tail.flatMap(entry => {
    const kind = taskStepKind(entry);
    const text = entry.text || entry.title || entry.command || entry.path || entry.input?.text;
    if (!text) return [];
    const role = entry.type === 'user' ? 'source' : entry.type === 'interaction' ? 'request'
      : entry.type === 'text' ? 'agent' : kind ? 'step' : undefined;
    return role ? [{ role, text, kind, status: entry.status }] : [];
  }).slice(-10);
  return { steps, plan, change, snapshot };
}

export function recordedTimestamp(value: unknown): number | undefined {
  if (value == null || value === '') return;
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  const timestamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

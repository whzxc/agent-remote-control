import type { AgentTimelineEntry, TurnTiming } from "../types.ts";

export type TimelineGroup = { id: string; turnId?: string; entries: AgentTimelineEntry[] };
// Turn ids keep disclosures stable when history arrives before a live entry.
export function timelineGroups(entries: readonly AgentTimelineEntry[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  const fallback = !entries.some(entry => entry.turnId);
  for (const entry of entries) {
    const turnId = fallback ? undefined : entry.turnId || undefined;
    const id = turnId ? `turn:${turnId}` : "turn:session";
    const group = groups.get(id) ?? { id, turnId, entries: [] };
    group.entries.push(entry);
    groups.set(id, group);
  }
  return [...groups.values()];
}
export function entryDuration(entry: AgentTimelineEntry, now: number): number | undefined {
  const duration = entry.durationMs ?? (entry.startedAt && (entry.endedAt || entry.status === "running")
    ? (entry.endedAt ? Date.parse(entry.endedAt) : now) - Date.parse(entry.startedAt) : NaN);
  return Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}
export function turnEntries(entries: readonly AgentTimelineEntry[], live: boolean, completed = !live && entries.every(entry => !["running", "pending", "failed", "cancelled", "unknown"].includes(entry.status))) {
  const prompt = entries.find(entry => entry.type === "user");
  const marked = [...entries].reverse().find(entry => entry.type === "text" && entry.phase === "final_answer");
  const last = [...entries].reverse().find(entry => entry.type !== "notice");
  const final = marked ?? (!live && completed && last?.type === "text" ? last : undefined);
  return { prompt, final, work: entries.filter(entry => entry !== prompt && entry !== final) };
}
export function turnDuration(entries: readonly AgentTimelineEntry[], now: number, live: boolean, startedAt?: string | null, timing?: TurnTiming) {
  const prompt = entries.find(entry => entry.type === "user");
  const start = Date.parse(timing?.startedAt || startedAt || prompt?.startedAt || "");
  const ends = entries.map(entry => Date.parse(entry.endedAt || "")).filter(Number.isFinite);
  const recordedEnd = Date.parse(timing?.endedAt || "");
  const end = live ? now : Number.isFinite(recordedEnd) ? recordedEnd : ends.length ? Math.max(...ends) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}
// Sum execution spans; time between turns is not execution time.
export function timelineDuration(entries: readonly AgentTimelineEntry[], now: number, running: boolean, currentTurn?: string | null, timings: Record<string, TurnTiming> = {}, startedAt?: string | null) {
  const groups = timelineGroups(entries);
  const turns = new Map(groups.map(group => [group.turnId ?? "", group.entries]));
  for (const turn of Object.keys(timings)) if (!turns.has(turn)) turns.set(turn, []);
  const liveId = currentTurn || groups.at(-1)?.turnId || "";
  if (running && !turns.has(liveId)) turns.set(liveId, []);
  if (!turns.size) return;
  let total = 0;
  for (const [id, rows] of turns) {
    const live = running && id === liveId;
    const duration = turnDuration(rows, now, live, live ? startedAt : undefined, timings[id]);
    if (duration === undefined) return;
    total += duration;
  }
  return total;
}

export function workState(entries: readonly AgentTimelineEntry[]) {
  const files = (read: boolean) => new Set(entries.filter(entry => entry.type === "file" && (read ? entry.operation === "read" : entry.operation && entry.operation !== "read"))
    .flatMap(entry => entry.changes?.length ? entry.changes.map(change => change.path) : entry.path ? [entry.path] : [entry.id])).size;
  return {
    failed: entries.filter(entry => entry.status === "failed" || entry.type === "error").length,
    kinds: [...new Set(entries.map(entry => entry.type))].slice(0, 4),
    counts: {
      thinking: entries.filter(entry => entry.type === "thinking").length,
      command: entries.filter(entry => entry.type === "command").length,
      write: files(false), read: files(true),
      file: entries.filter(entry => entry.type === "file" && !entry.operation).length,
      tool: entries.filter(entry => entry.type === "tool").length,
    },
  };
}
export function workBlockOpen(live: boolean, manual?: boolean) { return manual ?? live; }

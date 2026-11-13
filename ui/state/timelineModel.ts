import type { AgentTimeline, AgentTimelineEntry } from "../types.ts";

export function mergeTimeline(current: AgentTimeline | undefined, next: AgentTimeline): AgentTimeline {
  if (!current || current.sessionId !== next.sessionId) return next;
  const entries = new Map(current.entries.map(entry => [entry.id, entry]));
  for (const entry of next.entries) entries.set(entry.id, entry);
  return { ...next,
    ...(current.turnDispatchSummaries || next.turnDispatchSummaries ? { turnDispatchSummaries: {
      ...current.turnDispatchSummaries, ...next.turnDispatchSummaries,
    } } : {}),
    ...(current.turnTimings || next.turnTimings ? { turnTimings: { ...current.turnTimings, ...next.turnTimings } } : {}),
    ...(current.turnStatuses || next.turnStatuses ? { turnStatuses: { ...current.turnStatuses, ...next.turnStatuses } } : {}),
    entries: [...entries.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) };
}
// Full re-reads keep unchanged entry objects so memoized settled turns skip rendering.
export function reuseTimelineEntries(current: AgentTimeline | undefined, next: AgentTimeline): AgentTimeline {
  if (!current || current.sessionId !== next.sessionId) return next;
  const previous = new Map(current.entries.map(entry => [entry.id, entry]));
  return { ...next, entries: next.entries.map(entry => {
    const old = previous.get(entry.id);
    return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
  }) };
}
export async function refreshTimeline(current: AgentTimeline | undefined, read: (after?: number) => Promise<AgentTimeline>) {
  try { return mergeTimeline(current, await read(current?.cursor)); }
  catch (error) {
    if (!String(error).includes("TIMELINE_CURSOR_EXPIRED")) throw error;
    return read();
  }
}
export function followsTimeline(scrollTop: number, clientHeight: number, scrollHeight: number, previousTop = scrollTop) {
  const bottom = Math.max(0, scrollHeight - clientHeight);
  // Removing the latest button or collapsing content can clamp scrollTop upward.
  // Compare with the previous position clamped to the same layout, not a stale limit.
  const clamped = previousTop > bottom;
  return scrollTop >= Math.min(previousTop, bottom) - (clamped ? 1 : 0) && bottom - scrollTop <= 24;
}
export function timelineScrollTarget(following: boolean, running: boolean, initial: boolean, scrollHeight: number) {
  return following && (running || initial) ? scrollHeight : undefined;
}

// The existing snapshot supplies objects, not a tool/request join id. Only match
// a preceding tool in the same turn with the exact object; never match by title.
export function interactionTool(entries: readonly AgentTimelineEntry[], interaction: AgentTimelineEntry) {
  const index = entries.indexOf(interaction);
  if (index < 0) return;
  const candidates = entries.slice(0, index).filter(entry => entry.turnId === interaction.turnId
    && ["file", "command", "tool"].includes(entry.type)
    && (interaction.interaction?.path ? entry.path === interaction.interaction.path
      : !!interaction.interaction?.command && entry.command === interaction.interaction.command));
  // Parallel requests for the same object are ambiguous without a join id.
  if (candidates.filter(entry => entry.status === "pending" && !entry.endedAt).length > 1) return;
  return candidates.at(-1);
}
export function permissionRequestLabel(tool?: AgentTimelineEntry) {
  if (tool?.type === "command") return "timeline.commandRequest";
  if (tool?.operation === "read") return "timeline.readRequest";
  if (tool?.operation && ["write", "edit", "create"].includes(tool.operation)) return "timeline.writeRequest";
  return "timeline.fileRequest";
}
export function expandableTimelineEntry(entry: AgentTimelineEntry) {
  return !!(entry.text?.trim() || entry.cwd || entry.input?.text || entry.output?.text || entry.exitCode !== undefined
    || entry.changes?.some(change => change.path !== entry.path) || entry.truncated || entry.input?.truncated || entry.output?.truncated);
}

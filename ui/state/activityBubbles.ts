import { createStore } from "./store";
import { activityLayout, activityReadMatches, pruneActivityReads, type ActivityRead, type TrackedActivity } from "./activityModel";
import type { AgentActivitySession } from "../types";

// Geometry remains renderer-scoped. Read acknowledgements use durable WebView
// storage shared by UI and agent operations, including after window recreation.
export const trackedActivity = createStore<Record<string, TrackedActivity[]>>({});
export interface ActivityReadTarget { agent: string; id: string; agentAccountId?: string | null }
const storageKey = "arc.activity-reads";
const key = (agent: string, id: string) => JSON.stringify([agent, id]);
function saveReads(rows: ActivityRead[], now = Date.now()) {
  const value = JSON.stringify(pruneActivityReads(rows, now));
  try { if (localStorage.getItem(storageKey) !== value) localStorage.setItem(storageKey, value); }
  catch { throw new Error("TASK_READ_PERSIST_FAILED: read state was not saved; free WebView storage and retry task_mark_read"); }
}
function loadReads(now = Date.now()): ActivityRead[] {
  const raw = localStorage.getItem(storageKey);
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : []; } catch { value = []; }
  const rows = pruneActivityReads(value, now);
  if (raw !== null) saveReads(rows, now);
  return rows;
}
export function resetActivityBubbles() { trackedActivity.set({}); }
export function observeActivityTurn(agent: string, session: AgentActivitySession, previous?: TrackedActivity) {
  const rows = loadReads(), read = rows.find(row => row.agent === agent && row.id === session.id);
  if (!read) return;
  const comparable = !!(read.turnId && session.turnId || read.turnStartedAt && session.turnStartedAt);
  if (!activityReadMatches(read, session) || previous?.endedAt !== undefined && !comparable) {
    saveReads(rows.filter(row => row !== read));
  }
}
export function rememberActivityRead(agent: string, session: AgentActivitySession, readAt: number) {
  const rows = loadReads();
  saveReads([{ agent, id: session.id, readAt,
    ...(session.turnId ? { turnId: session.turnId } : {}), ...(session.turnStartedAt ? { turnStartedAt: session.turnStartedAt } : {}) },
    ...rows.filter(row => row.agent !== agent || row.id !== session.id)]);
}
export function markActivitiesRead(targets: readonly ActivityReadTarget[]) {
  const selected = new Set(targets.map(target => key(target.agent, target.id))), now = Date.now();
  const completed = Object.entries(trackedActivity.get()).flatMap(([agent, sessions]) => sessions
    .filter(session => session.endedAt !== undefined && selected.has(key(agent, session.id)))
    .map(session => ({ agent, session })));
  if (!completed.length) return;
  const marked = new Set(completed.map(({ agent, session }) => key(agent, session.id)));
  // Save the whole selection before dismissing any bubble. Storage failure leaves it unread.
  saveReads([...completed.map(({ agent, session }) => ({ agent, id: session.id, readAt: now,
    ...(session.turnId ? { turnId: session.turnId } : {}), ...(session.turnStartedAt ? { turnStartedAt: session.turnStartedAt } : {}) })),
    ...loadReads(now).filter(row => !marked.has(key(row.agent, row.id)))], now);
  trackedActivity.set(old => Object.fromEntries(Object.entries(old).map(([agent, sessions]) =>
    [agent, sessions.filter(session => session.endedAt === undefined || !marked.has(key(agent, session.id)))])));
}
export function restoreActivityReads(agent: string, sessions: TrackedActivity[], now: number, pinnedId?: string) {
  const reads = new Map(loadReads(now).map(row => [key(row.agent, row.id), row]));
  return sessions.flatMap(session => {
    if (session.endedAt === undefined) return [session];
    const read = reads.get(key(agent, session.id));
    const restored = read && activityReadMatches(read, session);
    let readAt = restored ? read.readAt : session.readAt;
    if (!read && readAt !== undefined && session.id === pinnedId) readAt = now;
    if (!read && readAt !== undefined) rememberActivityRead(agent, session, readAt);
    // A completion rediscovered after reload or transcript resampling must not
    // reappear. An already displayed detail keeps its existing dismissal delay.
    if (restored && session.readAt === undefined && session.id !== pinnedId) return [];
    if (readAt !== undefined && session.id !== pinnedId && now >= readAt + activityLayout.hold + activityLayout.fade) return [];
    return [{ ...session, ...(readAt === undefined ? {} : { readAt }) }];
  });
}
export function activityBubbleSnapshot() {
  const reads = new Map(loadReads().map(row => [key(row.agent, row.id), row]));
  const current = Object.entries(trackedActivity.get()).flatMap(([agent, sessions]) => sessions.map(session => {
    const completed = session.endedAt !== undefined, read = reads.get(key(agent, session.id));
    const readAt = completed && read && activityReadMatches(read, session) ? read.readAt : null;
    return { agent, id: session.id, completed, unread: completed && readAt === null, readAt, retained: true };
  }));
  const keys = new Set(current.map(row => key(row.agent, row.id)));
  return [...current, ...[...reads.values()].filter(row => !keys.has(key(row.agent, row.id)))
    .map(row => ({ agent: row.agent, id: row.id, readAt: row.readAt, completed: true, unread: false, retained: false }))];
}
export interface ActivityBubbleRequest { agent: string; id: string; action?: "mark-read" }
export function controlActivityBubble(request: ActivityBubbleRequest) {
  if (request.action !== undefined && request.action !== "mark-read") throw new Error("TASK_BUBBLE_ACTION_UNSUPPORTED: use task_mark_read to mark a completed bubble read");
  const current = () => activityBubbleSnapshot().find(row => row.agent === request.agent && row.id === request.id);
  const bubble = current();
  if (!bubble) throw new Error("TASK_BUBBLE_NOT_FOUND: read app.snapshot model.taskBubbles for current renderer task IDs");
  if (request.action === "mark-read") {
    if (!bubble.completed) throw new Error("TASK_BUBBLE_ACTIVE: only completed bubbles can be marked read; read task_bubble again after completion");
    if (bubble.unread) {
      markActivitiesRead([request]);
    }
  }
  return current()!;
}

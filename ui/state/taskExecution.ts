import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { api } from "../api";
import type { AgentTimeline } from "../types";
import { createStore } from "./store";
import { trackedActivity, rememberActivityRead, restoreActivityReads } from "./activityBubbles";
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
  trackedActivity.set(old => {
    let changed = false;
    const sessions = (old[agent] ?? []).map(session => {
      if (session.id !== id || session.observed !== false) return session;
      const status = executionStatus(execution, session.turnId);
      if (!terminalState(taskState(status, false))) return session;
      const nativeEnd = Date.parse(execution.turnTimings?.[session.turnId ?? execution.turnId ?? ""]?.endedAt ?? "");
      const selected = agentPanel.get();
      const readAt = session.readAt ?? (selected?.agent === agent && selected.session?.id === id ? Date.now() : undefined);
      const endedAt = Number.isFinite(nativeEnd) ? nativeEnd : session.endedAt ?? Date.now();
      if (session.status === status && session.endedAt === endedAt && session.readAt === readAt) return session;
      changed = true;
      const next = { ...session, status, endedAt, ...(readAt === undefined ? {} : { readAt }) };
      if (readAt !== undefined) rememberActivityRead(agent, next, readAt);
      return next;
    });
    const selected = agentPanel.get();
    return changed ? { ...old, [agent]: restoreActivityReads(agent, sessions, Date.now(), selected?.agent === agent ? selected.session?.id : undefined) } : old;
  });
}
export function refreshTaskExecution(agent: string, id: string, recent = false, force = false): Promise<void> {
  const identity = key(agent, id), pending = reads.get(identity);
  if (pending) return pending;
  if (!force && taskExecution(agent, id) && performance.now() - (lastRead.get(identity) ?? -Infinity) < 10000) return Promise.resolve();
  lastRead.set(identity, performance.now());
  const started = generation;
  const read = api<AgentTimeline>("agents/conversations/timeline", "POST", { agent, id, ...(recent ? { recent: true } : {}) })
    .then(timeline => { if (started === generation) acceptTaskExecution(agent, id, timeline); })
    .finally(() => { if (reads.get(identity) === read) reads.delete(identity); });
  reads.set(identity, read); return read;
}
export function useTaskExecution(agent: string, id: string, turnId: string | null | undefined, enabled: boolean) {
  const execution = useSyncExternalStore(taskExecutions.subscribe, () => taskExecution(agent, id));
  const terminal = terminalState(taskState(executionStatus(execution, turnId), false));
  useEffect(() => {
    if (!enabled || !agent || terminal) return;
    const read = () => { void refreshTaskExecution(agent, id).catch(() => {}); };
    read(); const timer = setInterval(read, 10000);
    return () => clearInterval(timer);
  }, [agent, id, turnId, enabled, terminal]);
  return execution;
}

const MAX_PREVIEW_CONCURRENCY = 4;
const PREVIEW_BACKOFF = [400, 1200];
const previewQueue: (() => Promise<void>)[] = [];
let activePreviews = 0;

function drainPreviewQueue() {
  while (activePreviews < MAX_PREVIEW_CONCURRENCY && previewQueue.length) {
    const read = previewQueue.shift()!;
    activePreviews++;
    void read().finally(() => {
      activePreviews--;
      drainPreviewQueue();
    });
  }
}

export function isTransientPreviewError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : error;
  const text = [code, message].filter(part => typeof part === 'string').join(' ');
  const namedError = text.match(/\b[A-Z]+(?:_[A-Z]+)+\b/)?.[0];
  if (namedError) return /^(DESKTOP_BUSY|FRONT_DOOR_BUSY|FRONT_DOOR_UNAVAILABLE|FRONT_DOOR_CORE_LOST|CORE_UNAVAILABLE)$/.test(namedError);
  return /\b(Cannot connect to local Core|Core is not ready|core shutting down|Failed to fetch|Load failed|timeout)\b/i.test(text);
}

/** Only visible task snapshots request background timeline previews. */
export function useTaskPreview(agent: string, id: string, enabled: boolean, card: RefObject<HTMLElement | null>, settled: boolean, turn?: string | null) {
  const [failed, setFailed] = useState(false);
  const retryRead = useRef<() => void>(undefined);
  const retry = useCallback(() => retryRead.current?.(), []);
  useEffect(() => {
    setFailed(false);
    if (!enabled || !card.current) return;
    let visible = false, stopped = false, loaded = false, blocked = false, pending = false;
    let attempt = 0, retries = 0;
    let backoff: ReturnType<typeof setTimeout> | undefined;
    let cached = taskExecution(agent, id);
    const unsubscribe = taskExecutions.subscribe(() => {
      const execution = taskExecution(agent, id);
      if (execution && execution !== cached) {
        blocked = false;
        if (backoff !== undefined) {
          clearTimeout(backoff);
          backoff = undefined;
          retries = 0;
        }
        setFailed(false);
      }
      cached = execution;
    });
    const canRead = () => !stopped && visible && !document.hidden && !blocked &&
      !(settled && (loaded || cached?.entries.some(entry => !turn || entry.turnId === turn)));
    const schedule = (manual = false) => {
      if (!manual && (pending || backoff !== undefined || !canRead())) return;
      pending = true;
      const current = attempt, started = generation;
      const read = async () => {
        if (current !== attempt || stopped) return;
        try {
          if (started !== generation || (!manual && !canRead())) return;
          const olderTurn = !!turn && !!cached?.turnId && turn !== cached.turnId;
          await refreshTaskExecution(agent, id, manual || !olderTurn, manual || settled && !!cached);
          if (current === attempt && !stopped && started === generation) {
            loaded = true;
            retries = 0;
            setFailed(false);
          }
        } catch (error) {
          if (current !== attempt || stopped || started !== generation) return;
          const delay = PREVIEW_BACKOFF[retries];
          if (delay !== undefined && isTransientPreviewError(error)) {
            retries++;
            backoff = setTimeout(() => {
              backoff = undefined;
              schedule();
            }, delay);
          } else {
            blocked = true;
            setFailed(true);
          }
        } finally {
          if (current === attempt) pending = false;
        }
      };
      if (manual) void read();
      else {
        previewQueue.push(read);
        drainPreviewQueue();
      }
    };
    retryRead.current = () => {
      attempt++;
      clearTimeout(backoff);
      backoff = undefined;
      blocked = false;
      loaded = false;
      retries = 0;
      setFailed(false);
      schedule(true);
    };
    const read = () => schedule();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      read();
    }) : undefined;
    observer?.observe(card.current);
    document.addEventListener("visibilitychange", read);
    const timer = settled ? undefined : setInterval(read, 10000);
    return () => {
      stopped = true;
      retryRead.current = undefined;
      unsubscribe();
      observer?.disconnect();
      clearTimeout(backoff);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [agent, id, enabled, card, settled, turn]);
  return { failed, retry };
}

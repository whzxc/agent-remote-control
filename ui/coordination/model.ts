import type { TrackedActivity, ApprovalSubmission } from '../state/activityModel.ts';
import { activityState, type TaskExecution } from '../state/taskExecutionModel.ts';
import { pendingSessions } from '../state/taskInteractions.ts';

export interface BoardRecord {
  id: string; revision: number; resources: string[]; state: string; ownerSourceId?: string; localOrigin?: boolean;
  intent?: string; summary?: string; expectedDurationSeconds?: number; causeCode?: string;
  lastActiveAt: string; inactivityAgeSeconds: number | null; observedAt: string; activityCoverage: string;
  threadLinks?: { threadId: string; observedTurnId?: string; scopeState: string }[];
  closedReason?: string; reason?: string; evidenceIds?: string[]; fixingCommit?: { projectId: string; oid: string };
  suggestedNextStep?: string; clearedAt?: string; clearedBy?: unknown;
}
export interface Conflict { noticeId: string; resource: string; state: string }
export interface BoardAttention { kind: 'blocker' | 'ax-candidate' | 'ax-triage' | 'notification'; id: string; summary?: string; reason?: string; ownerSourceId?: string; requiredActor: 'you' | 'source' | 'user'; open?: number; blocking?: number }
export interface BoardPage { attention?: { items: BoardAttention[]; coverage: Record<string, string> }; notificationProblems?: { id: string; sourceId: string; reason: string }[]; notificationCoverage?: string; notices: BoardRecord[]; blockers: BoardRecord[]; nextCursor?: string | null; observedAt: string; activityCoverage: string; conflicts?: Conflict[]; conflictCoverage?: string }
export interface JournalEvent {
  eventId: string; sequence: number; kind: string; summary: string; observedAt: string; status?: string;
  resources: string[]; origin?: { type: string; sourceId?: string }; threadRefs: { threadId: string; turnId?: string }[];
  evidenceRefs: { kind: string; id: string }[]; observation?: Record<string, unknown>; attribution?: unknown;
}
export interface EventPage { events: JournalEvent[]; nextCursor: string; oldestCursor: string; hasMore: boolean; observedAt: string; coverage: Record<string, unknown>; resetCursor?: string; error?: { code: string; message: string }; gap?: unknown }
export type TaskAttention = { id: string; kind: 'task'; agent: string; session: TrackedActivity; state: 'needsYou' | 'failed' | 'interrupted' };
export type Attention = TaskAttention | { id: string; kind: 'blocker'; record: BoardRecord } | { id: string; kind: 'connection'; connectionId: string; title: string; notification?: boolean } | { id: string; kind: 'update'; title: string } | { id: string; kind: 'ax'; item: BoardAttention };
export function taskAttention(activity: Record<string, readonly TrackedActivity[]>, executions: Record<string, TaskExecution>, submissions: Record<string, ApprovalSubmission>): TaskAttention[] {
  const items = new Map<string, TaskAttention>();
  for (const [agent, sessions] of Object.entries(activity)) for (const session of sessions) {
    const execution = executions[JSON.stringify([agent, session.id])];
    const pending = pendingSessions(agent, session, execution?.interactions ?? [], submissions).length > 0;
    const state = activityState(session, execution, pending);
    if (!pending && execution?.turnId && execution.turnId !== session.turnId && ['running', 'inProgress', 'completed'].includes(execution.status ?? '')) continue;
    if (state !== 'needsYou' && state !== 'failed' && state !== 'interrupted') continue;
    const id = JSON.stringify([agent, session.id, session.turnId]);
    items.set(id, { id, kind: 'task', agent, session, state });
  }
  // Completion-read dismissal belongs to homepage bubbles. Cached owner outcomes
  // remain actionable after their bubble disappears, until a successor recovers.
  for (const [key, execution] of Object.entries(executions)) {
    const [agent, id] = JSON.parse(key) as [string, string];
    if ((activity[agent] ?? []).some(session => session.id === id)) continue;
    if (execution.status !== 'failed' && !['interrupted', 'cancelled'].includes(execution.status ?? '')) continue;
    const state = execution.status === 'failed' ? 'failed' : 'interrupted';
    const identity = JSON.stringify([agent, id, execution.turnId]);
    items.set(identity, { id: identity, kind: 'task', agent, state, session: { id, source: agent === 'codex' ? 'codex-thread' : 'arc-task', phase: 'idle', headline: '', timeline: true, phaseSince: null, orderAt: 0, observed: false, status: execution.status, turnId: execution.turnId } });
  }
  return [...items.values()];
}
export function groupEvents(events: readonly JournalEvent[]) {
  const groups = new Map<string, JournalEvent[]>();
  for (const event of [...events].sort((a, b) => b.sequence - a.sequence)) {
    const refs = event.threadRefs ?? [], operation = event.evidenceRefs?.find(ref => ['receipt', 'request', 'replacement'].includes(ref.kind));
    const key = operation ? JSON.stringify(['operation', operation.kind, operation.id])
      : refs.length === 1 && refs[0].turnId ? JSON.stringify(['turn', refs[0].threadId, refs[0].turnId]) : event.eventId;
    const group = groups.get(key);
    if (group) group.push(event); else groups.set(key, [event]);
  }
  return [...groups.values()];
}
export function mergeEvents(previous: readonly JournalEvent[], next: readonly JournalEvent[]) {
  return [...new Map([...previous, ...next].map(event => [event.eventId, event])).values()].sort((a,b) => b.sequence - a.sequence).slice(0, 20000);
}
export const liveRecord = (row: BoardRecord) => !['closed', 'withdrawn', 'cleared'].includes(row.state);

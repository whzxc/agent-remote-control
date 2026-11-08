import { useEffect } from 'react';
import { api } from '../api';
import { createStore } from '../state/store';
import { trackedActivity } from '../state/activityBubbles';
import { taskExecutions } from '../state/taskExecution';
import { activityApprovals, agentActivity } from '../state/activity';
import { connector } from '../state/connector';
import { updates } from '../state/updates';
import { liveRecord, taskAttention, type Attention, type BoardPage } from './model';

/** history widens Current to closed, withdrawn and cleared records; the other filters narrow live matters. */
export const centerView = createStore<{ view: 'current' | 'activity' | 'ax'; filter: 'all' | 'attention' | 'input' | 'history'; resource: string }>({ view: 'current', filter: 'all', resource: '' });
export const boardObservation = createStore<{ page?: BoardPage; error: string; loading: boolean }>({ error: '', loading: false });
let reading: Promise<void> | undefined;
let generation = 0;
let observationCore: string | undefined;
export function ownerResult<T>(value: T): T {
  const failed = value as { error?: { code?: string; message?: string }; state?: string };
  if (failed.error) throw new Error(`${failed.error.code ?? ''}: ${failed.error.message ?? JSON.stringify(failed.error)}`);
  return value;
}
export function refreshBoard() {
  if (reading) return reading;
  const before = generation;
  boardObservation.set(old => ({ ...old, loading: true }));
  return reading = (async () => {
    try {
      let page = ownerResult(await api<BoardPage>('coordination/board', 'POST', { view: 'full', limit: 100 }));
      let conflictCoverage = page.conflictCoverage;
      const notices = [...page.notices], blockers = [...page.blockers], conflicts = [...page.conflicts ?? []];
      // Bulletin capacity is 256 notices and 128 blockers. Never report a partial zero.
      for (let count = 1; page.nextCursor && count < 4; count++) {
        page = ownerResult(await api<BoardPage>('coordination/board', 'POST', { view: 'full', limit: 100, cursor: page.nextCursor }));
        if (page.conflictCoverage !== 'observed') conflictCoverage = page.conflictCoverage;
        notices.push(...page.notices); blockers.push(...page.blockers); conflicts.push(...page.conflicts ?? []);
      }
      if (page.nextCursor) throw new Error('COORDINATION_PARTIAL: refresh the bulletin to complete coverage');
      if (before === generation) boardObservation.set({ page: { ...page, notices, blockers, conflicts, conflictCoverage }, error: '', loading: false });
    } catch (error) { if (before === generation) boardObservation.set(old => ({ ...old, error: String(error), loading: false })); }
    finally { reading = undefined; }
  })();
}
export function resetBoardObservation() { generation++; boardObservation.set({ error: '', loading: false }); }
export function useBoardObservation(enabled: boolean) {
  const core = connector.use().status?.core.backendSession;
  useEffect(() => {
    if (core && observationCore && core !== observationCore) resetBoardObservation();
    if (core) observationCore = core;
    if (!enabled) return;
    const read = () => { if (!document.hidden) void refreshBoard(); };
    read();
    const timer = setInterval(read, 15000);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [enabled, core]);
}
export function attentionProjection() {
  const tasks = taskAttention(trackedActivity.get(), taskExecutions.get(), activityApprovals.get()), board = boardObservation.get();
  const connection = connector.get(), update = updates.get(), observed = agentActivity.get();
  const items: Attention[] = [...tasks, ...(board.page?.blockers ?? []).filter(liveRecord).map(record => ({ id: record.id, kind: 'blocker' as const, record }))];
  for (const ingress of connection.status?.ingresses ?? []) if (ingress.error || ingress.state === 'error' || ingress.state === 'failed') items.push({ id: `connection:${ingress.id}`, kind: 'connection', connectionId: ingress.id, title: ingress.name });
  for (const problem of board.page?.notificationProblems ?? []) {
    const source = connection.sources.find(source => source.id === problem.sourceId && source.state !== 'revoked');
    const ingress = connection.status?.ingresses.find(row => row.id === source?.ingressId);
    if (source && ingress) items.push({ id: `notification:${problem.id}`, kind: 'connection', connectionId: ingress.id, title: source.label, notification: true });
  }
  if (update.error) items.push({ id: 'update', kind: 'update', title: update.version ?? 'ARC' });
  for (const item of board.page?.attention?.items ?? []) if (item.kind === 'ax-candidate' || item.kind === 'ax-triage') items.push({ id: `ax:${item.id}`, kind: 'ax', item });
  const complete = !!board.page && !board.error && board.page.attention?.coverage.ax === 'observed' && board.page.activityCoverage === 'observed' && board.page.notificationCoverage === 'observed' && !!observed.snapshot && !observed.error && !!connection.status && !connection.error && update.checked;
  return { items, complete };
}
export function useAttention() {
  trackedActivity.use(); taskExecutions.use(); activityApprovals.use(); boardObservation.use(); connector.use(); updates.use(); agentActivity.use();
  return attentionProjection();
}
export function coordinationSnapshot() {
  const attention = attentionProjection();
  return { view: centerView.get(), attention: { complete: attention.complete, count: attention.complete ? attention.items.length : null, items: attention.items.map(item => ({ id: item.id, kind: item.kind })) }, board: boardObservation.get() };
}

export const boardOpen = createStore(false);
export const boardFocus = createStore<string | undefined>(undefined);
export function openCenter() {
  boardFocus.set(undefined);
  centerView.set(old => ({ ...old, view: 'current', filter: 'all' }));
  boardOpen.set(true);
}

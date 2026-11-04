import type { BoardPage, BoardRecord, EventPage, JournalEvent } from './coordination/model';
export type CoordinationFixture = 'normal' | 'empty' | 'gap' | 'unavailable' | 'problems';
export function coordinationScenario(mode?: CoordinationFixture) {
  const at = '2026-01-01T00:00:00.000Z';
  const ago = (minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
  let gap = mode === 'gap';
  let unavailable = mode === 'unavailable';
  const base = { revision: 1, ownerSourceId: 'fixture-source', resources: ['project:sample/main', 'lane:sample/review'], lastActiveAt: at, observedAt: at, inactivityAgeSeconds: 120, activityCoverage: 'observed', state: 'active' };
  const notices: BoardRecord[] = mode === 'empty' || !mode ? [] : [
    { ...base, id: 'notice-a', lastActiveAt: ago(2), inactivityAgeSeconds: 120, intent: 'Review the shared renderer and registered worktree', expectedDurationSeconds: 1800, threadLinks: [{ threadId: 'fixture-task-0', observedTurnId: 'fixture-turn-0-1', scopeState: 'running' }] },
    { ...base, id: 'notice-b', lastActiveAt: ago(25), inactivityAgeSeconds: 1500, localOrigin: true, ownerSourceId: undefined, intent: 'Coordinate the release candidate across registered resources. Preserve linked task ownership, keep interrupted work visible, and record evidence before clearing resource conditions. 并行任务、资源所有者与活动覆盖情况均需保留，长内容可完整查看。', resources: ['app:installed'], expectedDurationSeconds: 3600, threadLinks: [] },
    { ...base, id: 'notice-old', lastActiveAt: ago(1500), intent: 'Previous maintenance scope', state: 'withdrawn', closedReason: 'owner-inactive', activityCoverage: 'restart-gap' },
  ];
  const blockers: BoardRecord[] = mode === 'empty' || !mode ? [] : [
    { ...base, id: 'blocker-a', lastActiveAt: ago(433), summary: 'Registered build lane needs an explicit recovery decision', causeCode: 'build-unconfirmed', state: 'stale', activityCoverage: 'thread-observation-gap', inactivityAgeSeconds: 26000, evidenceIds: ['receipt-build'] },
    { ...base, id: 'blocker-b', summary: 'Owner activity is uncertain; keep this resource condition uncleared', causeCode: 'owner-unavailable', resources: ['app:installed'], state: 'uncertain', activityCoverage: 'clock-uncertain', inactivityAgeSeconds: null },
  ];
  const events: JournalEvent[] = mode === 'empty' || !mode ? [] : Array.from({ length: 8 }, (_, index) => ({
    eventId: `event-${index}`, sequence: index + 1, kind: index < 2 ? 'receipt.stalled' : index < 4 ? 'turn.terminal' : index === 4 ? 'git.ref-moved' : index === 5 ? 'blocker.changed' : index === 6 ? 'app.restarted' : 'notification.delivery-failed',
    summary: index < 2 ? 'Receipt progress stalled' : index < 4 ? 'Task terminal outcome observed' : index === 4 ? 'Registered Git ref changed' : index === 5 ? 'Blocker state changed' : index === 6 ? 'ARC restarted' : 'Notification delivery attempt failed',
    status: index < 2 ? 'unconfirmed' : index === 2 ? 'failed' : index === 3 ? 'completed' : 'active', observedAt: ago((8 - index) * 17),
    resources: index === 6 ? ['app:installed'] : ['project:sample/main'], origin: { type: 'source', sourceId: 'fixture-source' },
    threadRefs: index < 4 ? [{ threadId: 'fixture-task-1', turnId: index === 3 ? 'fixture-turn-1-2' : 'fixture-turn-1-1' }] : [],
    evidenceRefs: index < 2 ? [{ kind: 'receipt', id: 'receipt-a' }] : index === 5 ? [{ kind: 'blocker', id: 'blocker-a' }] : [],
  }));
  function failure(code: string) { return { error: { code, message: 'Refresh the current owner record and retry.' } }; }
  return (path: string, method: string, body?: unknown): unknown => {
    const args = (body ?? {}) as Record<string, any>;
    if (path === 'coordination/resources' && method === 'GET') return { resources: [{ key: 'app:installed', label: 'ARC' }, { key: 'project:sample/main', label: 'Sample project' }, { key: 'lane:sample/review', label: 'Review lane' }], coverage: 'cached', observedAt: at };
    if (!path.startsWith('coordination/')) return undefined;
    if (method !== 'POST') throw new Error('SCENARIO_ACTION_UNAVAILABLE');
    if (path === 'coordination/events') {
      if (gap) { gap = false; return { ...failure('CURSOR_EXPIRED'), events: [], resetCursor: 'fixture-reset', nextCursor: 'fixture-reset', oldestCursor: 'fixture-reset', coverage: { state: 'partial', gap: 'retention' }, hasMore: false, observedAt: at }; }
      const scope = args.resource ?? 'all';
      if (args.since && !String(args.since).includes(scope) && args.since !== 'fixture-reset') return failure('CURSOR_SCOPE_CHANGED');
      const rows = events.filter(row => !args.resource || row.resources.includes(args.resource));
      return { events: args.since?.startsWith('tail:') ? [] : rows, nextCursor: `tail:${scope}`, oldestCursor: `oldest:${scope}`, hasMore: false, observedAt: at, coverage: { state: mode === 'gap' ? 'partial' : 'observed', observers: { git: { state: 'observed' } } } } satisfies EventPage;
    }
    if (path === 'coordination/board') {
      if (unavailable && !args.id) { unavailable = false; throw new Error('SCENARIO_BOARD_UNAVAILABLE'); }
      const filter = (row: BoardRecord) => (!args.id || row.id === args.id) && (!args.resource || row.resources.includes(args.resource)) && (args.id || args.state === 'all' || !['closed','withdrawn','cleared'].includes(row.state));
      const attention = { coverage: { bulletin: 'observed', ax: 'observed', notifications: 'observed' }, items: mode && mode !== 'empty' ? [{ kind: 'ax-candidate' as const, id: 'ax-candidate-a', summary: 'Task detail reopens the previous turn after resume', ownerSourceId: 'fixture-source', requiredActor: 'source' as const }] : [] };
      return { attention, notificationProblems: mode === 'problems' ? [{ id: 'notification-a', sourceId: 'fixture-source', reason: 'delivery-failed' }] : [], notificationCoverage: 'observed', notices: notices.filter(filter), blockers: blockers.filter(filter), nextCursor: null, observedAt: at, activityCoverage: 'observed', conflicts: notices.filter(row => row.state === 'active').flatMap(row => row.resources.map(resource => ({ noticeId: row.id, resource, state: row.state }))), conflictCoverage: 'observed' } satisfies BoardPage;
    }
    throw new Error(`SCENARIO_ACTION_UNAVAILABLE: ${path}`);
  };
}

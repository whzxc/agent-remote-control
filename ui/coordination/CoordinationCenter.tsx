import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { Notice } from '../components/kit/alert';
import { Button, IconButton } from '../components/kit/button';
import { HintTooltip } from '../components/kit/tooltip';
import Panel from '../components/ui/Panel';
import { RecordDetail, RecordEmpty, RecordSurface } from '../components/ui/RecordDetail';
import { TaskCard, localTaskCard } from '../components/ui/TaskCard';
import { connector, refreshConnector } from '../state/connector';
import { acceptActivity } from '../state/activity';
import type { AgentActivitySnapshot } from '../types';
import { trackedActivity } from '../state/activityBubbles';
import { tasks } from '../state/tasks';
import { agents } from '../state/agents';
import { taskExecutions } from '../state/taskExecution';
import { selectAgentPanel, selectIngressPanel, panelBack } from '../state/overviewPanels';
import { activityState } from '../state/taskExecutionModel';
import { showUpdate } from '../state/updates';
import { useAppNow } from '../state/appEnvironment';
import { createStore } from '../state/store';
import { layers } from '../state/layers';
import { oauthApproval, openNavigationAttention } from '../state/externalNavigation';
import { dayKey, relativeTime } from '../lib/relativeTime';
import { groupEvents, liveRecord, mergeEvents, type Attention, type BoardPage, type BoardRecord, type EventPage, type JournalEvent } from './model';
import { attentionLook, clock, duration, eventTone, recordLook, stateTone } from './presentation';
import { boardObservation, boardOpen, boardFocus, centerView, ownerResult, refreshBoard, useAttention } from './state';
import { BoardEventRowView, BoardTimelineGroupView } from './BoardEventView';
import { BoardRecordDetailView, BoardRowView, BoardSectionView, type BoardDetailFact } from './BoardRecordView';
import { BoardEmptyView, BoardFeedbackView, BoardFiltersView, BoardFooterView, BoardViewNavigation, CoordinationBoardView } from './CoordinationBoardView';
import { RecordHeading } from './Record';
import AXPanel, { axSelection } from './AXPanel';
import { axObservation, refreshAX } from './axState';
import './center.css';

interface ResourceOption { key: string; label: string }

export const centerReturn = createStore<{ kind: 'connection' | 'update'; focusId: string } | undefined>(undefined);
const selectedRecord = createStore<BoardRecord | undefined>(undefined);
let recordFocus = '';
const journal = createStore<{ page?: EventPage; rows: JournalEvent[]; resource: string; historyCursor?: string; error: string; reset?: string; gap?: { resource: string; observedAt: string; coverage: unknown } }>({ rows: [], resource: '', error: '' });
const date = (value?: string) => value ? new Date(value).toLocaleString(locale.get(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const known = (prefix: string, value: string) => t(`${prefix}.${value}`) === `${prefix}.${value}` ? value : t(`${prefix}.${value}`);
const stateName = (value: string) => known('center.state', value);
const coverageName = (value: string) => known('center.coverageState', value);

function Section({ label, count, note, attention, children }: { label: string; count?: number; note?: string; attention?: boolean; children: ReactNode }) {
  return <BoardSectionView label={label} count={count} note={note} attention={attention}>{children}</BoardSectionView>;
}

export default function CoordinationCenter() {
  const initialFocus = boardFocus.use();
  const view = centerView.use(), observed = boardObservation.use(), attention = useAttention(), feed = journal.use();
  const tracked = trackedActivity.use(), taskRecords = tasks.use().records, inventory = agents.use().items;
  const connection = connector.use();
  const ax = axObservation.use();
  const now = useAppNow(30_000), language = locale.use();
  const [resources, setResources] = useState<ResourceOption[]>([]), [resourceError, setResourceError] = useState('');
  const [history, setHistory] = useState<BoardPage>(), [historyError, setHistoryError] = useState(''), [loadingHistory, setLoadingHistory] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [reading, setReading] = useState(false), [rawEvent, setRawEvent] = useState('');
  const selected = selectedRecord.use(), setSelected = selectedRecord.set;
  const firstSelection = useRef(true);
  const showHistory = view.view === 'current' && view.filter === 'history';

  useEffect(() => {
    const returning = firstSelection.current && initialFocus;
    firstSelection.current = false;
    if (selected && !returning) requestAnimationFrame(() => document.getElementById('center-record-heading')?.focus());
  }, [selected?.id]);

  function closeRecord() {
    setSelected(undefined);
    requestAnimationFrame(() => (document.getElementById(recordFocus) ?? document.querySelector<HTMLElement>('[role="dialog"]'))?.focus());
  }

  const historyRequest = useRef(0);
  const generation = useRef(0), mounted = useRef(true), pending = useRef<number | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void api<{ resources: ResourceOption[]; coverage: string }>('coordination/resources')
      .then(result => { if (!cancelled) { setResources(result.resources); setResourceError(result.coverage === 'unavailable' ? t('center.resourcesUnavailable') : ''); } })
      .catch(error => { if (!cancelled) setResourceError(String(error)); });
    return () => { cancelled = true; };
  }, []);

  async function readEvents(mode: 'refresh' | 'history' | 'reset' = 'refresh') {
    if (pending.current === generation.current) return;
    const before = generation.current; pending.current = before; setReading(true);
    const current = journal.get(), sameScope = current.resource === view.resource;
    const since = mode === 'reset' ? current.reset : mode === 'history' ? current.historyCursor ?? current.page?.oldestCursor : sameScope ? current.page?.nextCursor : undefined;
    try {
      const page = await api<EventPage>('coordination/events', 'POST', { limit: 100, ...(view.resource ? { resource: view.resource } : {}), ...(since ? { since } : {}) });
      if (!mounted.current || before !== generation.current) return;
      if (page.error) { journal.set(old => ({ ...old, error: `${page.error!.code}: ${page.error!.message}`, reset: page.resetCursor, gap: page.resetCursor ? { resource: view.resource, observedAt: page.observedAt, coverage: page.coverage } : old.gap })); return; }
      journal.set({ page: mode === 'history' ? current.page ?? page : page, rows: mergeEvents(sameScope && mode !== 'reset' ? current.rows : [], page.events), resource: view.resource, historyCursor: mode === 'history' ? page.hasMore ? page.nextCursor : '' : sameScope ? current.historyCursor : undefined, error: '', reset: undefined, gap: current.gap?.resource === view.resource ? current.gap : undefined });
    } catch (error) { if (mounted.current && before === generation.current) journal.set(old => ({ ...old, error: String(error) })); }
    finally { if (pending.current === before) pending.current = undefined; if (mounted.current && before === generation.current) setReading(false); }
  }

  useEffect(() => {
    generation.current++;
    if (view.view !== 'activity') { setReading(false); return; }
    const read = () => { if (!document.hidden) void readEvents(); };
    read(); const timer = setInterval(read, 15000);
    document.addEventListener('visibilitychange', read);
    return () => { generation.current++; clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [view.resource, view.view]);

  async function readHistory(cursor?: string) {
    const before = generation.current, request = ++historyRequest.current; setLoadingHistory(true);
    try {
      const page = ownerResult(await api<BoardPage>('coordination/board', 'POST', { view: 'full', state: 'all', limit: 100, ...(view.resource ? { resource: view.resource } : {}), ...(cursor ? { cursor } : {}) }));
      if (mounted.current && before === generation.current && request === historyRequest.current) { setHistory(old => cursor && old ? { ...page, notices: [...old.notices, ...page.notices], blockers: [...old.blockers, ...page.blockers] } : page); setHistoryError(''); }
    } catch (error) { if (mounted.current && before === generation.current && request === historyRequest.current) setHistoryError(String(error)); }
    finally { if (mounted.current && request === historyRequest.current) setLoadingHistory(false); }
  }

  useEffect(() => { setHistory(undefined); setHistoryError(''); if (showHistory) void readHistory(); }, [showHistory, view.resource]);

  function taskTarget(threadId: string, turnId?: string) {
    for (const [agent, sessions] of Object.entries(tracked)) {
      const session = sessions.find(session => session.id === threadId);
      if (session && inventory.some(item => item.agent === agent)) return { agent, session: { ...session, ...(turnId ? { selectedTurnId: turnId } : {}) } };
    }
    const record = taskRecords.find(record => (record.threadId ?? record.taskId) === threadId && record.agent && inventory.some(item => item.agent === record.agent));
    if (!record?.agent) {
      const key = Object.keys(taskExecutions.get()).find(key => { const [agent, id] = JSON.parse(key); return id === threadId && inventory.some(item => item.agent === agent); });
      if (!key) return;
      const [agent] = JSON.parse(key) as [string, string];
      return { agent, session: { id: threadId, source: agent === 'codex' ? 'codex-thread' as const : 'arc-task' as const, phase: 'idle' as const, headline: '', phaseSince: null, timeline: true, orderAt: 0, observed: false, conversation: true, selectedTurnId: turnId } };
    }
    return { agent: record.agent, session: { id: threadId, title: record.runtime?.title ?? record.task.title, origin: record.origin ?? record.task.origin,
      project: record.runtime?.project ?? record.task.project ?? record.task.directory,
      dispatchSummary: { model: record.task.model ?? record.requested?.model, effort: record.task.effort ?? record.requested?.effort, serviceTier: record.requested?.serviceTier },
      source: record.agent === 'codex' ? 'codex-thread' as const : 'arc-task' as const, phase: 'idle' as const, headline: '', phaseSince: null, timeline: true, orderAt: 0, observed: false, conversation: true, selectedTurnId: turnId } };
  }

  function openTask(threadId: string, turnId: string | undefined, focusId: string) {
    const target = taskTarget(threadId, turnId); if (!target) return;
    panelBack.set({ open: () => { boardFocus.set(focusId); boardOpen.set(true); }, label: t('center.title') });
    layers.switchPanel(() => { boardOpen.set(false); selectAgentPanel({ type: 'task', ...target }); });
  }

  function openAttention(item: Attention, focusId: string) {
    if (item.kind === 'feedback') return;
    if (item.kind === 'oauth') { oauthApproval.set({ id: item.requestId }); return; }
    if (item.kind === 'navigation') { openNavigationAttention(item.title); return; }
    if (item.kind === 'blocker') { void readRecord(item.record); return; }
    if (item.kind === 'task') { openTask(item.session.id, item.session.turnId ?? undefined, focusId); return; }
    if (item.kind === 'ax') return;
    centerReturn.set({ kind: item.kind, focusId }); boardOpen.set(false);
    if (item.kind === 'update') showUpdate();
    else { const ingress = connection.status?.ingresses.find(row => row.id === item.connectionId); if (ingress) selectIngressPanel(ingress); }
  }

  async function readRecord(row: Pick<BoardRecord, 'id'> & Partial<BoardRecord>) {
    if (selected?.id !== row.id) recordFocus = document.activeElement?.id ?? '';
    setSelected({ resources: [], revision: 0, state: 'unknown', lastActiveAt: '', observedAt: '', inactivityAgeSeconds: null, activityCoverage: 'unavailable', summary: row.id, ...row }); setDetailError('');
    try { const page = ownerResult(await api<BoardPage>('coordination/board', 'POST', { id: row.id, view: 'full' })); const full = [...page.notices, ...page.blockers].find(r => r.id === row.id); if (!full) throw new Error('COORDINATION_NOT_FOUND'); if (mounted.current) setSelected(old => old?.id === row.id ? full : old); }
    catch (error) { if (mounted.current && selectedRecord.get()?.id === row.id) setDetailError(String(error)); }
  }

  const patch = (value: Partial<typeof view>) => { setSelected(undefined); axSelection.set(undefined); centerView.set(old => ({ ...old, ...value })); };
  const ago = (value?: string | null) => relativeTime(value, now, language, t('time.justNow'));
  const page = showHistory ? history : observed.page;
  const boardRows = [...page?.notices ?? [], ...page?.blockers ?? []].filter(row => (!view.resource || row.resources.includes(view.resource)) && view.filter !== 'input' && (view.filter === 'all' || showHistory || row.intent == null && liveRecord(row)));
  const notices = boardRows.filter(row => row.intent != null), blockers = boardRows.filter(row => row.intent == null);
  const activeWork = view.filter === 'all' ? Object.entries(tracked).flatMap(([agent, sessions]) => sessions.filter(session => activityState(session, taskExecutions.get()[JSON.stringify([agent, session.id])]) === 'running' && !observed.page?.notices.some(row => row.threadLinks?.some(link => link.threadId === session.id)) && !view.resource).map(session => ({ agent, session }))) : [];
  const options = [...new Map([ ...observed.page?.notices.flatMap(row => row.resources.map(key => ({ key, label: key }))) ?? [], ...observed.page?.blockers.flatMap(row => row.resources.map(key => ({ key, label: key }))) ?? [], ...feed.rows.flatMap(row => row.resources.map(key => ({ key, label: key }))), ...resources].map(row => [row.key, row])).values()];
  const scopedAttention = showHistory ? [] : attention.items.filter(item => (view.filter !== 'input' || item.kind === 'task' && item.state === 'needsYou') && (!view.resource || item.kind === 'blocker' && item.record.resources.includes(view.resource) || item.kind === 'task' && observed.page?.notices.some(row => row.resources.includes(view.resource) && row.threadLinks?.some(link => link.threadId === item.session.id))));
  const ownerAttention = scopedAttention.filter(item => item.kind !== 'blocker');
  const resourceLabel = (key: string) => options.find(option => option.key === key)?.label ?? key;
  const title = (item: Attention) => item.kind === 'task' ? item.session.title ?? taskTarget(item.session.id)?.session.title ?? item.session.id : item.kind === 'blocker' ? item.record.summary : item.kind === 'ax' ? item.item.summary ?? t('center.axTriage', { count: item.item.open ?? 0 }) : item.title;
  const sourceName = (id?: string) => connection.sources.find(source => source.id === id)?.label ?? id ?? t('center.unknown');
  const owner = (row: BoardRecord) => row.localOrigin ? t('center.local') : connection.sources.find(source => source.id === row.ownerSourceId)?.label ?? row.ownerSourceId ?? t('center.unknown');
  const kindLabel = (item: Attention) => item.kind === 'feedback' ? t('connect.actionFailed') : item.kind === 'oauth' ? t('connect.approveTitle') : item.kind === 'navigation' ? t('open') : item.kind === 'task' ? t(item.state === 'needsYou' ? 'center.waitUser' : `detail.state.${item.state}`) : t(item.kind === 'connection' && item.notification ? 'center.notification' : `center.${item.kind}`);
  const busy = (view.view === 'ax' ? ax.loading : reading || observed.loading || loadingHistory) || !!pendingAction;
  const runAction = async (action: string, run: () => Promise<unknown>) => { setPendingAction(action); try { await run(); } finally { setPendingAction(''); } };

  function attentionRow(item: Attention) {
    const id = `attention-${encodeURIComponent(item.id)}`;
    if (item.kind === 'task') {
      const available = !!taskTarget(item.session.id);
      const task = localTaskCard(item.agent, { ...item.session, title: title(item) }, item.state === 'needsYou' ? 'needs-me' : 'recent');
      return <TaskCard key={item.id} task={task} form={item.state === 'needsYou' ? 'detail' : 'summary'} now={now}
        readTimeline={false} description={available ? kindLabel(item) : t('center.targetUnavailable')} trigger={{ id, disabled: !available }}
        onOpen={available ? () => openAttention(item, id) : undefined} />;
    }
    const look = attentionLook(item);
    if (item.kind === 'feedback') return <BoardRowView key={item.id} icon={look.icon} tone={look.tone} title={item.title} interactive={false} />;
    if (item.kind === 'ax') return <BoardRowView key={item.id} icon={look.icon} tone={look.tone} title={title(item)} meta={[item.item.kind === 'ax-candidate' ? t('center.axCandidate', { source: sourceName(item.item.ownerSourceId) }) : t('center.axTriageWait')]} interactive={false} />;
    return <BoardRowView key={item.id} id={id} icon={look.icon} tone={look.tone} title={title(item)} meta={[kindLabel(item)]} onClick={() => openAttention(item, id)} />;
  }

  function recordRow(row: BoardRecord) {
    const live = liveRecord(row), look = recordLook(row);
    const meta: ReactNode[] = [
      (row.intent == null || !live || row.state !== 'active') ? stateName(row.state) : null,
      owner(row),
      row.lastActiveAt ? <HintTooltip text={date(row.lastActiveAt)}><time dateTime={row.lastActiveAt}>{ago(row.lastActiveAt)}</time></HintTooltip> : null,
      row.activityCoverage !== 'observed' ? t(`center.coverage.${row.activityCoverage}`) : null,
      ...row.resources.map(resourceLabel),
    ];
    return <BoardRowView key={row.id} id={`record-${row.id}`} icon={look.icon} tone={look.tone} title={row.intent ?? row.summary ?? row.id}
      meta={meta} muted={!live} expanded={selected?.id === row.id} controlsId={selected?.id === row.id ? 'center-record-detail' : undefined}
      onClick={() => void readRecord(row)} />;
  }

  function renderDetail(row: BoardRecord) {
    const linked = row.threadLinks ?? [];
    const conflicts = (observed.page?.conflicts ?? []).filter(conflict => conflict.noticeId !== row.id && row.resources.includes(conflict.resource))
      .map(conflict => ({ key: `${conflict.noticeId}:${conflict.resource}`, message: t('center.conflict', { resource: resourceLabel(conflict.resource), id: conflict.noticeId }) }));
    const facts: BoardDetailFact[] = [
      { label: t('center.activity'), value: <><HintTooltip text={date(row.lastActiveAt)}><time dateTime={row.lastActiveAt}>{row.lastActiveAt ? ago(row.lastActiveAt) : '—'}</time></HintTooltip>{row.activityCoverage !== 'observed' && <span className="text-text-secondary"> · {t(`center.coverage.${row.activityCoverage}`)}</span>}</> },
      { label: t('center.observed'), value: <HintTooltip text={date(row.observedAt)}><time dateTime={row.observedAt}>{row.observedAt ? ago(row.observedAt) : '—'}</time></HintTooltip> },
      ...(row.expectedDurationSeconds != null ? [{ label: t('center.durationLabel'), value: duration(row.expectedDurationSeconds, language) }] : []),
      ...(row.causeCode ? [{ label: t('center.causeLabel'), value: <code className="font-mono text-meta">{row.causeCode}</code> }] : []),
      ...((row.reason || row.closedReason) ? [{ label: t('center.reason'), value: row.reason ?? stateName(row.closedReason!) }] : []),
      ...(row.evidenceIds?.length ? [{ label: t('center.evidenceLabel'), value: <code className="font-mono text-meta">{row.evidenceIds.join(' · ')}</code> }] : []),
      ...(row.fixingCommit ? [{ label: t('center.commit'), value: <code className="font-mono text-meta">{row.fixingCommit.projectId} · {row.fixingCommit.oid}</code> }] : []),
      ...(row.clearedAt ? [{ label: t('center.clearedAt'), value: <HintTooltip text={date(row.clearedAt)}><time dateTime={row.clearedAt}>{ago(row.clearedAt)}</time></HintTooltip> }] : []),
      ...(row.suggestedNextStep ? [{ label: t('center.next'), value: stateName(row.suggestedNextStep) }] : []),
    ];
    return <BoardRecordDetailView Container={RecordDetail} ariaLabel={t('center.recordDetail')} kindLabel={t(row.intent != null ? 'center.kind.notice' : 'center.kind.blocker')}
      title={row.intent ?? row.summary ?? row.id} backLabel={t('back')} onBack={closeRecord}
      statusLabel={stateName(row.state)} statusTone={stateTone(row.state)} ownerLabel={owner(row)} resources={row.resources.map(resourceLabel)}
      error={detailError || undefined} retryLabel={t('retry')} retryBusy={pendingAction === 'retry-detail'} retryDisabled={busy}
      onRetry={() => void runAction('retry-detail', () => readRecord(row))} conflicts={conflicts} facts={facts}
      linkedHeading={linked.length > 0 ? t('center.linkedTasks') : undefined}
      linkedTasks={linked.length > 0 ? linked.map(link => {
        const target = taskTarget(link.threadId, link.observedTurnId), id = `link-${row.id}-${link.threadId}`;
        return target ? <TaskCard key={link.threadId} task={localTaskCard(target.agent, target.session)} form="summary" now={now}
          trigger={{ id }} onOpen={() => openTask(link.threadId, link.observedTurnId, id)} />
          : <p key={link.threadId} className="m-0 text-meta text-text-secondary">{link.threadId} · {t('center.targetUnavailable')}</p>;
      }) : undefined}
      conflictsUnknownNote={observed.page?.conflictCoverage !== 'observed' ? t('center.conflictsUnknown') : undefined}
      metadataLabel={t('center.metadata')} metadataJson={JSON.stringify(row, null, 2)} />;
  }

  function renderEvent(event: JournalEvent, nested = false) {
    const evidence = event.evidenceRefs?.find(ref => ['notice', 'blocker'].includes(ref.kind));
    const sourceConnection = connection.sources.find(source => source.id === event.origin?.sourceId)?.ingressId;
    const row = evidence && [...observed.page?.notices ?? [], ...observed.page?.blockers ?? [], ...history?.notices ?? [], ...history?.blockers ?? []].find(item => item.id === evidence.id);
    const origin = event.origin?.type === 'local-authority' ? t('center.local') : connection.sources.find(source => source.id === event.origin?.sourceId)?.label ?? event.origin?.sourceId ?? event.origin?.type ?? t('center.unknown');
    const links = [
      ...(event.threadRefs ?? []).map(ref => {
        const target = taskTarget(ref.threadId, ref.turnId), id = `event-${event.eventId}-${ref.threadId}`;
        return target ? <TaskCard key={`${ref.threadId}:${ref.turnId}`} task={localTaskCard(target.agent, target.session)} form="summary" now={now}
          trigger={{ id }} onOpen={() => openTask(ref.threadId, ref.turnId, id)} />
          : <span key={`${ref.threadId}:${ref.turnId}`} className="text-meta text-text-secondary">{ref.threadId} {ref.turnId} · {t('center.targetUnavailable')}</span>;
      }),
      ...(evidence ? [<Button id={`record-ref-${event.eventId}`} key="record" variant="ghost" size="xs" className="max-w-full truncate text-accent-text" onClick={() => void readRecord(row ?? { id: evidence.id, resources: event.resources })}>{row ? row.intent ?? row.summary : evidence.id}</Button>] : []),
      ...(event.kind === 'notification.delivery-failed' && sourceConnection && connection.status?.ingresses.some(item => item.id === sourceConnection) ? [<Button id={`connection-${event.eventId}`} key="connection" variant="ghost" size="xs" className="text-accent-text" onClick={() => openAttention({ id: sourceConnection, kind: 'connection', connectionId: sourceConnection, title: sourceConnection }, `connection-${event.eventId}`)}>{t('connections.title')}</Button>] : []),
      ...(event.kind.startsWith('app.') ? [<Button id={`update-${event.eventId}`} key="update" variant="ghost" size="xs" className="text-accent-text" onClick={() => openAttention({ id: 'update', kind: 'update', title: 'ARC' }, `update-${event.eventId}`)}>{t('viewUpdate')}</Button>] : []),
    ];
    return <BoardEventRowView key={event.eventId} eventId={event.eventId} tone={eventTone(event)} summary={event.summary} nested={nested}
      timeNode={<HintTooltip text={date(event.observedAt)}><time dateTime={event.observedAt}>{clock(event.observedAt, language)}</time></HintTooltip>}
      rawOpen={rawEvent === event.eventId} metadataLabel={t('center.metadata')} onToggleRaw={() => setRawEvent(rawEvent === event.eventId ? '' : event.eventId)}
      statusLabel={event.status && event.status !== 'active' ? stateName(event.status) : undefined} statusTone={event.status ? stateTone(event.status) : undefined}
      originLabel={origin} resources={event.resources.map(resourceLabel)} links={links.length > 0 ? links : undefined} rawJson={JSON.stringify(event, null, 2)} />;
  }

  function renderTimeline(rows: JournalEvent[]) {
    const dayLabel = (value: string) => {
      const key = dayKey(value);
      if (key === dayKey(new Date(now).toISOString())) return t('center.today');
      if (key === dayKey(new Date(now - 86_400_000).toISOString())) return t('center.yesterday');
      return new Date(value).toLocaleDateString(language, { month: 'long', day: 'numeric', weekday: 'short' });
    };
    const days: { label: string; groups: JournalEvent[][] }[] = [];
    for (const group of groupEvents(rows)) {
      const label = dayLabel(group[0].observedAt);
      if (days.at(-1)?.label === label) days.at(-1)!.groups.push(group); else days.push({ label, groups: [group] });
    }
    return days.map(day => (
      <section key={day.label} className="flex flex-col gap-1" aria-label={day.label}>
        <RecordHeading>{day.label}</RecordHeading>
        <ol className="m-0 grid list-none p-0">
          {day.groups.map(group => group.length === 1 ? renderEvent(group[0]) : (
            <BoardTimelineGroupView key={group[0].eventId} tone={eventTone(group[0])} summary={group[0].summary} count={group.length}
              timeNode={<HintTooltip text={date(group[0].observedAt)}><time dateTime={group[0].observedAt}>{clock(group[0].observedAt, language)}</time></HintTooltip>}>
              {group.map(item => renderEvent(item, true))}
            </BoardTimelineGroupView>
          ))}
        </ol>
      </section>
    ));
  }

  const coverage = feed.page?.coverage as { state?: string } | undefined;
  const emptyCurrent = Boolean(page && !boardRows.length && !activeWork.length && !ownerAttention.length && !historyError && !observed.error);
  const footer = view.view === 'activity'
    ? feed.page && <BoardFooterView observedLabel={t('center.observedAgo', { time: ago(feed.page.observedAt) })} coverageLabel={coverageName(coverage?.state ?? 'unknown')}
        coverageWarning={coverage?.state !== 'observed'} coverageSummaryLabel={t('center.coverage')} coverageJson={JSON.stringify(feed.page.coverage, null, 2)} />
    : page && <BoardFooterView observedLabel={t('center.observedAgo', { time: ago(page.observedAt) })} />;

  const viewOptions = (['current', 'activity', 'ax'] as const).map(value => ({
    value, label: value === 'ax' ? 'AX' : t(value === 'activity' ? 'center.activityView' : `center.${value}`),
  }));
  const filterOptions = (['all', 'attention', 'input', 'history'] as const).map(value => ({ value, label: t(`center.${value}`) }));
  const resourceOptions = [{ value: 'all-resources', label: t('center.allResources') }, ...options.map(row => ({ value: row.key, label: row.label }))];

  return (
    <Panel initialFocus={initialFocus} title={t('center.title')} viewKey={view.view} busy={busy} footer={view.view === 'ax' ? undefined : footer}
      headerNavigation={<BoardViewNavigation label={t('center.view')} value={view.view} options={viewOptions} disabled={busy} onChange={next => patch({ view: next })} />}
      actions={<IconButton icon={RefreshCw} label={t('refresh')} busy={pendingAction === 'refresh' || !pendingAction && (view.view === 'ax' ? ax.loading : reading || observed.loading || loadingHistory)} disabled={busy} onClick={() => void runAction('refresh', async () => {
        if (view.view === 'ax') { await refreshAX(); return; }
        await Promise.allSettled([refreshBoard(), selected ? readRecord(selected) : Promise.resolve(), refreshConnector(), api<AgentActivitySnapshot>('agents/activity').then(acceptActivity), view.view === 'activity' ? readEvents() : showHistory ? readHistory() : Promise.resolve()]);
      })} />}
      onClose={() => { setSelected(undefined); axSelection.set(undefined); boardOpen.set(false); }} returnFocus="#board-trigger"
      onEscapeKeyDown={event => { if (view.view === 'ax' && axSelection.get()) { event.preventDefault(); axSelection.set(undefined); } else if (selected) { event.preventDefault(); closeRecord(); } }}>
      {view.view === 'ax' ? <RecordSurface className="flex min-h-0 flex-1 flex-col"><AXPanel /></RecordSurface> : (
        <CoordinationBoardView Surface={RecordSurface} EmptyContainer={RecordEmpty} busy={busy} resourceError={resourceError || undefined}
          filters={<BoardFiltersView showFilter={view.view === 'current'} filterLabel={t('center.filter')} filterValue={view.filter} filterOptions={filterOptions} onFilterChange={next => patch({ filter: next })}
            resourceLabel={t('center.resourceFilter')} resourceValue={view.resource || 'all-resources'} resourceOptions={resourceOptions} onResourceChange={resource => patch({ resource: resource === 'all-resources' ? '' : resource })} disabled={busy} />}
          notice={observed.error ? <BoardFeedbackView title={t('center.unavailable')} detail={observed.error} actionLabel={t('retry')} actionBusy={pendingAction === 'retry'} actionDisabled={busy} onAction={() => void runAction('retry', refreshBoard)} /> : undefined}
          detail={selected ? renderDetail(selected) : undefined}
          empty={view.view === 'current' && emptyCurrent}
          emptyMessage={t(view.filter === 'all' || showHistory ? 'center.emptyBoard' : 'center.noAttention')}
          moreActions={view.view === 'activity' ? <>
            {feed.page?.hasMore && <Button size="sm" busy={pendingAction === 'more'} disabled={busy} onClick={() => void runAction('more', () => readEvents())}>{t('center.more')}</Button>}
            {feed.page && feed.historyCursor !== '' && <Button size="sm" variant="ghost" busy={pendingAction === 'history'} disabled={busy} onClick={() => void runAction('history', () => readEvents('history'))}>{t('center.retainedHistory')}</Button>}
          </> : showHistory && history?.nextCursor ? <Button size="sm" busy={pendingAction === 'more'} disabled={busy} onClick={() => void runAction('more', () => readHistory(history.nextCursor!))}>{t('center.more')}</Button> : undefined}>
          {view.view === 'activity' ? (
            <section className="flex flex-col gap-4" aria-label={t('center.activityView')}>
              {feed.error && <BoardFeedbackView title={t(feed.reset ? 'center.gap' : 'center.unavailable')} detail={feed.error} actionLabel={t(feed.reset ? 'center.reset' : 'retry')} actionBusy={pendingAction === 'retry'} actionDisabled={busy} onAction={() => void runAction('retry', () => readEvents(feed.reset ? 'reset' : 'refresh'))} />}
              {feed.gap?.resource === view.resource && !feed.reset && <Notice tone="warning">{[t('center.retainedGap'), feed.gap.observedAt ? date(feed.gap.observedAt) : ''].filter(Boolean).join(' · ')}</Notice>}
              {!feed.rows.length && !reading && !feed.error && feed.page && <BoardEmptyView EmptyContainer={RecordEmpty} message={t('center.emptyEvents')} />}
              {renderTimeline(feed.resource === view.resource ? feed.rows : [])}
            </section>
          ) : <>
            {historyError && <BoardFeedbackView detail={historyError} actionLabel={t('retry')} actionBusy={pendingAction === 'retry-history'} actionDisabled={busy} onAction={() => void runAction('retry-history', () => readHistory())} />}
            {(ownerAttention.length > 0 || !attention.complete && !showHistory) && (
              <Section label={t('center.attention')} count={ownerAttention.length} attention note={!attention.complete ? t('center.partial') : undefined}>
                {ownerAttention.map(attentionRow)}
              </Section>
            )}
            {(activeWork.length > 0 || notices.length > 0) && (
              <Section label={t(showHistory ? 'center.notices' : 'center.work')} count={activeWork.length + notices.length}>
                {activeWork.map(({ agent, session }) => <TaskCard key={`${agent}:${session.id}`} task={localTaskCard(agent, session, 'running')} form="detail" now={now}
                  readTimeline={false} trigger={{ id: `work-${session.id}` }} onOpen={() => openTask(session.id, session.turnId ?? undefined, `work-${session.id}`)} />)}
                {notices.map(recordRow)}
              </Section>
            )}
            {blockers.length > 0 && <Section label={t('center.blockers')} count={blockers.length}>{blockers.map(recordRow)}</Section>}
          </>}
        </CoordinationBoardView>
      )}
    </Panel>
  );
}

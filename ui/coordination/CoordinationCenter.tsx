import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { Button, Checkbox, Dialog, IconButton, Notice, SingleChoice } from '../components/ui';
import { connector, refreshConnector } from '../state/connector';
import { acceptActivity } from '../state/activity';
import type { AgentActivitySnapshot } from '../types';
import { trackedActivity } from '../state/activityBubbles';
import { tasks } from '../state/tasks';
import { agents } from '../state/agents';
import { taskExecutions } from '../state/taskExecution';
import { selectAgentPanel, selectIngressPanel } from '../state/overviewPanels';
import { activityState } from '../state/taskExecutionModel';
import { showUpdate, refreshUpdate } from '../state/updates';
import { createStore } from '../state/store';
import { groupEvents, liveRecord, mergeEvents, type Attention, type BoardPage, type BoardRecord, type EventPage, type JournalEvent } from './model';
import { boardObservation, boardOpen, boardFocus, centerView, ownerResult, refreshBoard, useAttention } from './state';
interface ResourceOption { key: string; label: string }
import './center.css';

export const centerReturn = createStore<{ kind: 'task' | 'connection' | 'update'; focusId: string } | undefined>(undefined);
const selectedRecord = createStore<BoardRecord | undefined>(undefined);
let recordFocus = '';
const journal = createStore<{ page?: EventPage; rows: JournalEvent[]; resource: string; historyCursor?: string; error: string; reset?: string; gap?: { resource: string; observedAt: string; coverage: unknown } }>({ rows: [], resource: '', error: '' });
const date = (value?: string) => value ? new Date(value).toLocaleString(locale.get(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const stateName = (value: string) => t(`center.state.${value}`) === `center.state.${value}` ? value : t(`center.state.${value}`);

export default function CoordinationCenter() {
  const initialFocus = boardFocus.use();
  const view = centerView.use(), observed = boardObservation.use(), attention = useAttention(), feed = journal.use();
  const tracked = trackedActivity.use(), taskRecords = tasks.use().records, inventory = agents.use().items;
  const connection = connector.use();
  const [resources, setResources] = useState<ResourceOption[]>([]), [resourceError, setResourceError] = useState('');
  const [history, setHistory] = useState<BoardPage>(), [historyError, setHistoryError] = useState(''), [loadingHistory, setLoadingHistory] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [reading, setReading] = useState(false);
  const selected = selectedRecord.use(), setSelected = selectedRecord.set;
  const firstSelection = useRef(true);
  useEffect(() => {
    const returning = firstSelection.current && initialFocus;
    firstSelection.current = false;
    if (selected && !returning) requestAnimationFrame(() => document.getElementById('center-record-heading')?.focus());
  }, [selected?.id]);
  function closeRecord() { setSelected(undefined); requestAnimationFrame(() => (document.getElementById(recordFocus) ?? document.querySelector<HTMLElement>('[role="dialog"]'))?.focus()); }
  const historyRequest = useRef(0);
  const generation = useRef(0), mounted = useRef(true), pending = useRef<number | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void api<{ resources: ResourceOption[]; coverage: string }>('coordination/resources').then(result => { if (!cancelled) { setResources(result.resources); setResourceError(result.coverage === 'unavailable' ? t('center.resourcesUnavailable') : ''); } }).catch(error => { if (!cancelled) setResourceError(String(error)); });
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
  useEffect(() => { setHistory(undefined); setHistoryError(''); if (view.history && view.view === 'current') void readHistory(); }, [view.history, view.resource, view.view]);
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
    return { agent: record.agent, session: { id: threadId, title: record.task.title, source: record.agent === 'codex' ? 'codex-thread' as const : 'arc-task' as const, phase: 'idle' as const, headline: '', phaseSince: null, timeline: true, orderAt: 0, observed: false, conversation: true, selectedTurnId: turnId } };
  }
  function openTask(threadId: string, turnId: string | undefined, focusId: string) {
    const target = taskTarget(threadId, turnId); if (!target) return;
    centerReturn.set({ kind: 'task', focusId }); boardOpen.set(false); selectAgentPanel({ type: 'task', ...target });
  }
  function openAttention(item: Attention, focusId: string) {
    if (item.kind === 'blocker') { void readRecord(item.record); return; }
    if (item.kind === 'task') { openTask(item.session.id, item.session.turnId ?? undefined, focusId); return; }
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
  const patch = (value: Partial<typeof view>) => { setSelected(undefined); centerView.set(old => ({ ...old, ...value })); };
  const page = view.history ? history : observed.page;
  const boardRows = [...page?.notices ?? [], ...page?.blockers ?? []].filter(row => (!view.resource || row.resources.includes(view.resource)) && view.filter !== 'input' && (view.filter === 'all' || row.intent == null && liveRecord(row)));
  const notices = boardRows.filter(row => row.intent != null), blockers = boardRows.filter(row => row.intent == null);
  const activeWork = view.filter === 'all' ? Object.entries(tracked).flatMap(([agent, sessions]) => sessions.filter(session => activityState(session, taskExecutions.get()[JSON.stringify([agent, session.id])]) === 'running' && !observed.page?.notices.some(row => row.threadLinks?.some(link => link.threadId === session.id)) && !view.resource).map(session => ({ agent, session }))) : [];
  const options = [...new Map([ ...observed.page?.notices.flatMap(row => row.resources.map(key => ({ key, label: key }))) ?? [], ...observed.page?.blockers.flatMap(row => row.resources.map(key => ({ key, label: key }))) ?? [], ...feed.rows.flatMap(row => row.resources.map(key => ({ key, label: key }))), ...resources].map(row => [row.key, row])).values()];
  const scopedAttention = attention.items.filter(item => (view.filter !== 'input' || item.kind === 'task' && item.state === 'needsYou') && (!view.resource || item.kind === 'blocker' && item.record.resources.includes(view.resource) || item.kind === 'task' && observed.page?.notices.some(row => row.resources.includes(view.resource) && row.threadLinks?.some(link => link.threadId === item.session.id))));
  const ownerAttention = scopedAttention.filter(item => item.kind !== 'blocker');
  const resourceLabel = (key: string) => options.find(option => option.key === key)?.label ?? key;
  const title = (item: Attention) => item.kind === 'task' ? item.session.title ?? taskTarget(item.session.id)?.session.title ?? item.session.id : item.kind === 'blocker' ? item.record.summary : item.title;
  const owner = (row: BoardRecord) => row.localOrigin ? t('center.local') : connection.sources.find(source => source.id === row.ownerSourceId)?.label ?? row.ownerSourceId ?? t('center.unknown');
  function recordDetail(row: BoardRecord) {
    return <section id="center-record-detail" className="center-detail" aria-label={t('center.recordDetail')}>
      <header><h2 id="center-record-heading" tabIndex={-1}>{row.intent ?? row.summary}</h2><Button onClick={closeRecord}>{t('back')}</Button></header>
      {detailError && <Notice tone="danger" action={<Button onClick={() => void readRecord(row)}>{t('retry')}</Button>}>{detailError}</Notice>}
      <dl><dt>{t('center.owner')}</dt><dd>{owner(row)}</dd><dt>{t('center.state')}</dt><dd>{stateName(row.state)}</dd><dt>{t('center.resourceFilter')}</dt><dd>{row.resources.map(resourceLabel).join(' · ') || '—'}</dd><dt>{t('center.activity')}</dt><dd>{date(row.lastActiveAt)}{row.activityCoverage !== 'observed' && ` · ${t(`center.coverage.${row.activityCoverage}`)}`}</dd><dt>{t('center.observed')}</dt><dd>{date(row.observedAt)}</dd>
      {row.expectedDurationSeconds != null && <><dt>{t('center.durationLabel')}</dt><dd>{row.expectedDurationSeconds}s</dd></>}
      {row.causeCode && <><dt>{t('center.causeLabel')}</dt><dd>{row.causeCode}</dd></>}
      {(row.reason || row.closedReason) && <><dt>{t('center.reason')}</dt><dd>{row.reason ?? row.closedReason}</dd></>}
      {!!row.evidenceIds?.length && <><dt>{t('center.evidenceLabel')}</dt><dd>{row.evidenceIds.join(' · ')}</dd></>}
      {row.fixingCommit && <><dt>{t('center.commit')}</dt><dd>{row.fixingCommit.projectId} · {row.fixingCommit.oid}</dd></>}
      {row.clearedAt && <><dt>{t('center.clearedAt')}</dt><dd>{date(row.clearedAt)}</dd></>}
      {row.suggestedNextStep && <><dt>{t('center.next')}</dt><dd>{stateName(row.suggestedNextStep)}</dd></>}</dl>
      {row.threadLinks?.map(link => <div key={link.threadId} className="center-linked">{taskTarget(link.threadId, link.observedTurnId) ? <Button id={`link-${row.id}-${link.threadId}`} onClick={() => openTask(link.threadId, link.observedTurnId, `link-${row.id}-${link.threadId}`)}>{taskTarget(link.threadId)?.session.title ?? link.threadId}</Button> : <span>{link.threadId} · {t('center.targetUnavailable')}</span>}</div>)}
      {(observed.page?.conflicts ?? []).filter(conflict => conflict.noticeId !== row.id && row.resources.includes(conflict.resource)).map(conflict => <Notice key={`${conflict.noticeId}:${conflict.resource}`}>{t('center.conflict', { resource: conflict.resource, id: conflict.noticeId })}</Notice>)}
      {observed.page?.conflictCoverage !== 'observed' && <p>{t('center.conflictsUnknown')}</p>}
      <details><summary>{t('center.metadata')}</summary><pre>{JSON.stringify(row, null, 2)}</pre></details>

    </section>;
  }
  function eventRow(event: JournalEvent) {
    const evidence = event.evidenceRefs?.find(ref => ['notice','blocker'].includes(ref.kind));
    const sourceConnection = connection.sources.find(source => source.id === event.origin?.sourceId)?.ingressId;
    const row = evidence && [...observed.page?.notices ?? [], ...observed.page?.blockers ?? [], ...history?.notices ?? [], ...history?.blockers ?? []].find(row => row.id === evidence.id);
    return <article key={event.eventId} className="center-event">
      <strong>{event.summary}</strong><div className="center-row-meta"><time dateTime={event.observedAt}>{date(event.observedAt)}</time>{event.status && <span>{stateName(event.status)}</span>}</div>
      <div className="center-row-meta"><span>{event.origin?.type === 'local-authority' ? t('center.local') : connection.sources.find(source => source.id === event.origin?.sourceId)?.label ?? event.origin?.sourceId ?? event.origin?.type ?? t('center.unknown')}</span><span>{event.resources.map(resourceLabel).join(' · ')}</span></div>
      {event.threadRefs?.map(ref => taskTarget(ref.threadId, ref.turnId) ? <Button id={`event-${event.eventId}-${ref.threadId}`} key={`${ref.threadId}:${ref.turnId}`} onClick={() => openTask(ref.threadId, ref.turnId, `event-${event.eventId}-${ref.threadId}`)}>{taskTarget(ref.threadId)?.session.title ?? ref.threadId}</Button> : <p key={`${ref.threadId}:${ref.turnId}`}>{ref.threadId} {ref.turnId} · {t('center.targetUnavailable')}</p>)}
      {evidence && <Button id={`record-ref-${event.eventId}`} onClick={() => void readRecord(row ?? { id: evidence.id, resources: event.resources })}>{evidence.id}</Button>}
      {event.kind === 'notification.delivery-failed' && sourceConnection && connection.status?.ingresses.some(row => row.id === sourceConnection) && <Button id={`connection-${event.eventId}`} onClick={() => openAttention({ id: sourceConnection, kind: 'connection', connectionId: sourceConnection, title: sourceConnection }, `connection-${event.eventId}`)}>{t('connections.title')}</Button>}
      {event.kind.startsWith('app.') && <Button id={`update-${event.eventId}`} onClick={() => openAttention({ id: 'update', kind: 'update', title: 'ARC' }, `update-${event.eventId}`)}>{t('viewUpdate')}</Button>}
      <details><summary>{t('center.metadata')}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
    </article>;
  }
  return <Dialog initialFocus={initialFocus} title={t('center.title')} width={820} onClose={() => { setSelected(undefined); boardOpen.set(false); }} returnFocus="#board-trigger" onEscapeKeyDown={event => { if (selected) { event.preventDefault(); closeRecord(); } }}><div className="coordination-center">
    <div className="center-toolbar"><SingleChoice label={t('center.view')} value={view.view} onChange={value => patch({ view: value as 'current' | 'activity' })} options={['current','activity'].map(value => ({ value, label: t(value === 'activity' ? 'center.activityView' : `center.${value}`) }))} />
      <IconButton icon={RefreshCw} label={t('refresh')} busy={reading || observed.loading} onClick={() => { void refreshBoard(); if (selected) void readRecord(selected); void refreshConnector().catch(() => {}); void refreshUpdate().catch(() => {}); void api<AgentActivitySnapshot>('agents/activity').then(acceptActivity).catch(() => {}); if (view.view === 'activity') void readEvents(); else if (view.history) void readHistory(); }} />
      {view.view === 'current' && <SingleChoice compact label={t('center.filter')} value={view.filter} onChange={value => patch({ filter: value as typeof view.filter })} options={['all', 'attention', 'input'].map(value => ({ value, label: t(`center.${value}`) }))} />}
      {options.length > 1 && <SingleChoice compact label={t('center.resourceFilter')} value={view.resource || 'all-resources'} onChange={resource => patch({ resource: resource === 'all-resources' ? '' : resource })} options={[{ value: 'all-resources', label: t('center.allResources') }, ...options.map(row => ({ value: row.key, label: row.label }))]} />}
    </div>
    {(reading && !feed.page && view.view === 'activity' || observed.loading && !observed.page && view.view === 'current') && <p role="status">{t('loading')}</p>}
    {resourceError && <p role="status">{resourceError}</p>}
    {observed.error && <Notice tone="danger" action={<Button onClick={() => void refreshBoard()}>{t('retry')}</Button>}>{t('center.unavailable')} · {observed.error}</Notice>}
    <div className={`center-content ${selected ? 'has-detail' : ''}`}>
      {selected && recordDetail(selected)}<div className="center-list">{view.view === 'activity' ? <>
        <section aria-label={t('center.activityView')}>
          {feed.error && <Notice tone="danger" action={<Button onClick={() => void readEvents(feed.reset ? 'reset' : 'refresh')}>{t(feed.reset ? 'center.reset' : 'retry')}</Button>}>{feed.reset ? t('center.gap') : t('center.unavailable')} · {feed.error}</Notice>}
          {feed.gap?.resource === view.resource && !feed.reset && <Notice>{t('center.retainedGap')} · {date(feed.gap.observedAt)}</Notice>}
          {!!feed.page && <details><summary>{t('center.coverage')}</summary><pre>{JSON.stringify(feed.page.coverage, null, 2)}</pre></details>}
          {!feed.rows.length && !reading && !feed.error && feed.page && <p>{t('center.emptyEvents')}</p>}
          {groupEvents(feed.resource === view.resource ? feed.rows : []).map(group => group.length === 1 ? eventRow(group[0]) : <details className="center-group" key={group[0].eventId}><summary>{group[0].summary} · {group.length} · {date(group[0].observedAt)}</summary>{group.map(eventRow)}</details>)}
          {feed.page?.hasMore && <Button busy={reading} onClick={() => void readEvents()}>{t('center.more')}</Button>}
          {feed.page && feed.historyCursor !== '' && <Button busy={reading} onClick={() => void readEvents('history')}>{t('center.retainedHistory')}</Button>}
        </section>
      </> : <>
        <div className="center-board-actions"><Checkbox checked={view.history} onChange={history => patch({ history })}>{t('center.history')}</Checkbox></div>

        {historyError && <Notice tone="danger" action={<Button onClick={() => void readHistory()}>{t('retry')}</Button>}>{historyError}</Notice>}
        <section aria-label={t('center.attention')}>{(ownerAttention.length > 0 || !attention.complete) && <h2>{t('center.attention')}</h2>}
          {!attention.complete && <p role="status">{t('center.partial')}</p>}
          {ownerAttention.map(item => item.kind === 'task' && !taskTarget(item.session.id) ? <p key={item.id}>{title(item)} · {t('center.targetUnavailable')}</p> : <Button key={item.id} id={`attention-${encodeURIComponent(item.id)}`} className="center-attention-row" onClick={() => openAttention(item, `attention-${encodeURIComponent(item.id)}`)}><strong>{title(item)}</strong><span>{item.kind === 'task' ? t(item.state === 'needsYou' ? 'center.waitUser' : `detail.state.${item.state}`) : t(item.kind === 'connection' && item.notification ? 'center.notification' : `center.${item.kind}`)}</span></Button>)}
        </section>
        {(activeWork.length > 0 || notices.length > 0) && <h2>{t('center.work')}</h2>}
        {activeWork.map(({ agent, session }) => <Button key={`${agent}:${session.id}`} className="center-board-row" id={`work-${session.id}`} onClick={() => openTask(session.id, session.turnId ?? undefined, `work-${session.id}`)}><strong>{session.title ?? session.id}</strong><span>{agent} · {t('detail.state.running')}</span></Button>)}
        {notices.map(row => <Button className="center-board-row" key={row.id} id={`record-${row.id}`} aria-expanded={selected?.id === row.id} aria-controls={selected?.id === row.id ? 'center-record-detail' : undefined} onClick={() => void readRecord(row)}><strong>{row.intent ?? row.summary}</strong><span>{stateName(row.state)} · {owner(row)} · {date(row.lastActiveAt)}</span><span>{row.resources.map(resourceLabel).join(' · ')}{row.activityCoverage !== 'observed' && ` · ${t(`center.coverage.${row.activityCoverage}`)}`}</span></Button>)}
        {blockers.length > 0 && <h2>{t('center.blockers')}</h2>}
        {blockers.map(row => <Button className="center-board-row" key={row.id} id={`record-${row.id}`} aria-expanded={selected?.id === row.id} aria-controls={selected?.id === row.id ? 'center-record-detail' : undefined} onClick={() => void readRecord(row)}><strong>{row.summary}</strong><span>{stateName(row.state)} · {owner(row)} · {date(row.lastActiveAt)}</span><span>{row.resources.map(resourceLabel).join(' · ')} · {t(`center.coverage.${row.activityCoverage}`)}</span></Button>)}
        {page && !boardRows.length && !activeWork.length && !ownerAttention.length && !historyError && !observed.error && <p>{t(view.filter === 'all' ? 'center.emptyBoard' : 'center.noAttention')}</p>}

        {view.history && history?.nextCursor && <Button busy={loadingHistory} onClick={() => void readHistory(history.nextCursor!)}>{t('center.more')}</Button>}
      </>}
    </div></div>
  </div></Dialog>;
}

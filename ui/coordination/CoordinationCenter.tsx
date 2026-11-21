import { RecordSurface } from '../components/ui/RecordDetail';
import { RecordDetail, RecordEmpty } from '../components/ui/RecordDetail';
import { RecordDisclosure, RecordEvent, RecordFooter } from "./RecordParts";
import { RecordRow, RecordHeading, RecordCard, RecordMeta } from './Record';
import { layers } from "../state/layers";
import { Tooltip as HoverHelp } from "../components/ui/index";
import { oauthApproval, openNavigationAttention } from "../state/externalNavigation";
import Panel from "../components/ui/Panel";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Braces, ChevronDown, ChevronRight, Inbox, RefreshCw, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { Button, Icon, IconButton, Notice, SingleChoice, Tag, Tile } from '../components/ui';
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
import { dayKey, relativeTime } from '../lib/relativeTime';
import { groupEvents, liveRecord, mergeEvents, type Attention, type BoardPage, type BoardRecord, type EventPage, type JournalEvent } from './model';
import { attentionLook, clock, duration, eventTone, recordLook, stateTone, type Tone } from './presentation';
import { boardObservation, boardOpen, boardFocus, centerView, ownerResult, refreshBoard, useAttention } from './state';
interface ResourceOption { key: string; label: string }
import './center.css';
import AXPanel, { axSelection } from './AXPanel';
import { axObservation, refreshAX } from './axState';

export const centerReturn = createStore<{ kind: 'connection' | 'update'; focusId: string } | undefined>(undefined);
const selectedRecord = createStore<BoardRecord | undefined>(undefined);
let recordFocus = '';
const journal = createStore<{ page?: EventPage; rows: JournalEvent[]; resource: string; historyCursor?: string; error: string; reset?: string; gap?: { resource: string; observedAt: string; coverage: unknown } }>({ rows: [], resource: '', error: '' });
const date = (value?: string) => value ? new Date(value).toLocaleString(locale.get(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const known = (prefix: string, value: string) => t(`${prefix}.${value}`) === `${prefix}.${value}` ? value : t(`${prefix}.${value}`);
const stateName = (value: string) => known('center.state', value);
const coverageName = (value: string) => known('center.coverageState', value);

function RowGlyph({ icon, tone }: { icon: LucideIcon; tone: Tone }) {
  return <Tile icon={icon} form="phase" tone={tone} />;
}
function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Tag form="compact-status" tone={tone === "neutral" || tone === "accent" ? undefined : tone}>{children}</Tag>;
}
function Section({ label, count, note, attention, children }: { label: string; count?: number; note?: string; attention?: boolean; children: ReactNode }) {
  return <section className="center-section" data-attention={attention || undefined} aria-label={label}>
    <RecordHeading count={count} attention={attention} note={note}>{label}</RecordHeading>
    <div className="center-rows">{children}</div>
  </section>;
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
  const chips = (keys: readonly string[]) => keys.length > 0 && <span className="center-chips">{keys.map(key => <Tag key={key} form="resource">{resourceLabel(key)}</Tag>)}</span>;
  const coverageNote = (row: BoardRecord) => row.activityCoverage !== 'observed' && <span className="center-note">{t(`center.coverage.${row.activityCoverage}`)}</span>;
  function attentionRow(item: Attention) {
    const id = `attention-${encodeURIComponent(item.id)}`;
    if (item.kind === 'task') {
      const available = !!taskTarget(item.session.id);
      const task = localTaskCard(item.agent, { ...item.session, title: title(item) }, item.state === 'needsYou' ? 'needs-me' : 'recent');
      return <TaskCard key={item.id} task={task} form={item.state === 'needsYou' ? 'detail' : 'summary'} now={now}
        readTimeline={false}
        description={available ? kindLabel(item) : t('center.targetUnavailable')} trigger={{ id, disabled: !available }}
        onOpen={available ? () => openAttention(item, id) : undefined} />;
    }
    const look = attentionLook(item), meta = <RecordMeta>{kindLabel(item)}</RecordMeta>;
    if (item.kind === 'feedback') return <RecordCard key={item.id}><RowGlyph {...look} /><span className="record-row-body"><strong>{item.title}</strong></span></RecordCard>;
    if (item.kind === 'ax') return <RecordCard key={item.id}><RowGlyph {...look} /><span className="record-row-body"><strong>{title(item)}</strong><RecordMeta><span>{item.item.kind === 'ax-candidate' ? t('center.axCandidate', { source: sourceName(item.item.ownerSourceId) }) : t('center.axTriageWait')}</span></RecordMeta></span></RecordCard>;
    return <RecordRow key={item.id} id={id} onClick={() => openAttention(item, id)}><RowGlyph {...look} /><span className="record-row-body"><strong>{title(item)}</strong>{meta}</span><Icon icon={ChevronRight} className="center-row-go" /></RecordRow>;
  }
  function recordRow(row: BoardRecord) {
    const live = liveRecord(row);
    return <RecordRow key={row.id} id={`record-${row.id}`} className={live ? '' : 'muted'} aria-expanded={selected?.id === row.id} aria-controls={selected?.id === row.id ? 'center-record-detail' : undefined} onClick={() => void readRecord(row)}>
      <RowGlyph {...recordLook(row)} />
      <span className="record-row-body"><strong>{row.intent ?? row.summary}</strong>
        <RecordMeta>{(row.intent == null || !live || row.state !== 'active') && <span>{stateName(row.state)}</span>}<span>{owner(row)}</span>{row.lastActiveAt && <HoverHelp text={date(row.lastActiveAt)}><time dateTime={row.lastActiveAt}>{ago(row.lastActiveAt)}</time></HoverHelp>}{coverageNote(row)}{row.resources.map(key => <span key={key}>{resourceLabel(key)}</span>)}</RecordMeta>
      </span>
      <Icon icon={ChevronRight} className="center-row-go" />
    </RecordRow>;
  }
  function recordDetail(row: BoardRecord) {
    const linked = row.threadLinks ?? [], conflicts = (observed.page?.conflicts ?? []).filter(conflict => conflict.noticeId !== row.id && row.resources.includes(conflict.resource));
    const fact = (label: string, value: ReactNode) => <><dt>{label}</dt><dd>{value}</dd></>;
    return <RecordDetail id="center-record-detail" className="center-detail" aria-label={t('center.recordDetail')}>
      <header>
        <div className="center-detail-title"><span className="center-kind">{t(row.intent != null ? 'center.kind.notice' : 'center.kind.blocker')}</span><h2 id="center-record-heading" tabIndex={-1}>{row.intent ?? row.summary}</h2></div>
        <Button onClick={closeRecord}>{t('back')}</Button>
      </header>
      <RecordMeta as="div"><Pill tone={stateTone(row.state)}>{stateName(row.state)}</Pill><span>{owner(row)}</span>{chips(row.resources)}</RecordMeta>
      {detailError && <Notice tone="danger" action={<Button busy={pendingAction === 'retry-detail'} disabled={busy} onClick={() => void runAction('retry-detail', () => readRecord(row))}>{t('retry')}</Button>}>{detailError}</Notice>}
      {conflicts.map(conflict => <Notice key={`${conflict.noticeId}:${conflict.resource}`} tone="warning">{t('center.conflict', { resource: resourceLabel(conflict.resource), id: conflict.noticeId })}</Notice>)}
      <dl>
        {fact(t('center.activity'), <><HoverHelp text={date(row.lastActiveAt)}><time dateTime={row.lastActiveAt}>{row.lastActiveAt ? ago(row.lastActiveAt) : '—'}</time></HoverHelp>{row.activityCoverage !== 'observed' && <span className="center-note"> · {t(`center.coverage.${row.activityCoverage}`)}</span>}</>)}
        {fact(t('center.observed'), <HoverHelp text={date(row.observedAt)}><time dateTime={row.observedAt}>{row.observedAt ? ago(row.observedAt) : '—'}</time></HoverHelp>)}
        {row.expectedDurationSeconds != null && fact(t('center.durationLabel'), duration(row.expectedDurationSeconds, language))}
        {row.causeCode && fact(t('center.causeLabel'), <code>{row.causeCode}</code>)}
        {(row.reason || row.closedReason) && fact(t('center.reason'), row.reason ?? stateName(row.closedReason!))}
        {!!row.evidenceIds?.length && fact(t('center.evidenceLabel'), <code>{row.evidenceIds.join(' · ')}</code>)}
        {row.fixingCommit && fact(t('center.commit'), <code>{row.fixingCommit.projectId} · {row.fixingCommit.oid}</code>)}
        {row.clearedAt && fact(t('center.clearedAt'), <HoverHelp text={date(row.clearedAt)}><time dateTime={row.clearedAt}>{ago(row.clearedAt)}</time></HoverHelp>)}
        {row.suggestedNextStep && fact(t('center.next'), stateName(row.suggestedNextStep))}
      </dl>
      {linked.length > 0 && <div className="center-linked"><h3>{t('center.linkedTasks')}</h3>
        {linked.map(link => { const target = taskTarget(link.threadId, link.observedTurnId), id = `link-${row.id}-${link.threadId}`;
          return target ? <TaskCard key={link.threadId} task={localTaskCard(target.agent, target.session)} form="summary" now={now}
            trigger={{ id }} onOpen={() => openTask(link.threadId, link.observedTurnId, id)} />
            : <p key={link.threadId} className="center-note">{link.threadId} · {t('center.targetUnavailable')}</p>; })}
      </div>}
      {observed.page?.conflictCoverage !== 'observed' && <p className="center-note">{t('center.conflictsUnknown')}</p>}
      <RecordDisclosure className="center-technical"><summary><Icon icon={ChevronDown} />{t('center.metadata')}</summary><pre>{JSON.stringify(row, null, 2)}</pre></RecordDisclosure>
    </RecordDetail>;
  }
  function eventRow(event: JournalEvent) {
    const evidence = event.evidenceRefs?.find(ref => ['notice','blocker'].includes(ref.kind));
    const sourceConnection = connection.sources.find(source => source.id === event.origin?.sourceId)?.ingressId;
    const row = evidence && [...observed.page?.notices ?? [], ...observed.page?.blockers ?? [], ...history?.notices ?? [], ...history?.blockers ?? []].find(row => row.id === evidence.id);
    const origin = event.origin?.type === 'local-authority' ? t('center.local') : connection.sources.find(source => source.id === event.origin?.sourceId)?.label ?? event.origin?.sourceId ?? event.origin?.type ?? t('center.unknown');
    const links = [
      ...(event.threadRefs ?? []).map(ref => {
        const target = taskTarget(ref.threadId, ref.turnId), id = `event-${event.eventId}-${ref.threadId}`;
        return target ? <TaskCard key={`${ref.threadId}:${ref.turnId}`} task={localTaskCard(target.agent, target.session)} form="summary" now={now}
          trigger={{ id }} onOpen={() => openTask(ref.threadId, ref.turnId, id)} />
          : <span key={`${ref.threadId}:${ref.turnId}`} className="center-note">{ref.threadId} {ref.turnId} · {t('center.targetUnavailable')}</span>;
      }),
      ...(evidence ? [<Button id={`record-ref-${event.eventId}`} key="record" variant="ghost" presentation="record-link" className="center-link" onClick={() => void readRecord(row ?? { id: evidence.id, resources: event.resources })}>{row ? row.intent ?? row.summary : evidence.id}</Button>] : []),
      ...(event.kind === 'notification.delivery-failed' && sourceConnection && connection.status?.ingresses.some(row => row.id === sourceConnection) ? [<Button id={`connection-${event.eventId}`} key="connection" variant="ghost" presentation="record-link" className="center-link" onClick={() => openAttention({ id: sourceConnection, kind: 'connection', connectionId: sourceConnection, title: sourceConnection }, `connection-${event.eventId}`)}>{t('connections.title')}</Button>] : []),
      ...(event.kind.startsWith('app.') ? [<Button id={`update-${event.eventId}`} key="update" variant="ghost" presentation="record-link" className="center-link" onClick={() => openAttention({ id: 'update', kind: 'update', title: 'ARC' }, `update-${event.eventId}`)}>{t('viewUpdate')}</Button>] : []),
    ];
    return <RecordEvent key={event.eventId} className="center-event" data-tone={eventTone(event)}>
      <div className="center-event-line"><strong>{event.summary}</strong><HoverHelp text={date(event.observedAt)}><time dateTime={event.observedAt}>{clock(event.observedAt, language)}</time></HoverHelp>
        <IconButton icon={Braces} label={t('center.metadata')} className="center-raw-toggle" aria-expanded={rawEvent === event.eventId} aria-controls={`raw-${event.eventId}`} onClick={() => setRawEvent(rawEvent === event.eventId ? '' : event.eventId)} /></div>
      <RecordMeta as="div">{event.status && event.status !== 'active' && <Pill tone={stateTone(event.status)}>{stateName(event.status)}</Pill>}<span>{origin}</span>{chips(event.resources)}</RecordMeta>
      {links.length > 0 && <div className="center-event-links">{links}</div>}
      {rawEvent === event.eventId && <pre id={`raw-${event.eventId}`}>{JSON.stringify(event, null, 2)}</pre>}
    </RecordEvent>;
  }
  function dayLabel(value: string) {
    const key = dayKey(value);
    if (key === dayKey(new Date(now).toISOString())) return t('center.today');
    if (key === dayKey(new Date(now - 86_400_000).toISOString())) return t('center.yesterday');
    return new Date(value).toLocaleDateString(language, { month: 'long', day: 'numeric', weekday: 'short' });
  }
  function timeline(rows: JournalEvent[]) {
    const days: { label: string; groups: JournalEvent[][] }[] = [];
    for (const group of groupEvents(rows)) {
      const label = dayLabel(group[0].observedAt);
      if (days.at(-1)?.label === label) days.at(-1)!.groups.push(group); else days.push({ label, groups: [group] });
    }
    return days.map(day => <section key={day.label} className="center-day" aria-label={day.label}><RecordHeading>{day.label}</RecordHeading>
      <ol className="center-timeline">{day.groups.map(group => group.length === 1 ? eventRow(group[0]) : <RecordEvent key={group[0].eventId} className="center-event" data-tone={eventTone(group[0])}>
        <details className="center-group"><summary><span className="center-event-line"><strong>{group[0].summary}</strong><span className="center-count">{group.length}</span><HoverHelp text={date(group[0].observedAt)}><time dateTime={group[0].observedAt}>{clock(group[0].observedAt, language)}</time></HoverHelp></span></summary>
          <ol className="center-timeline nested">{group.map(eventRow)}</ol></details></RecordEvent>)}</ol>
    </section>);
  }
  const coverage = feed.page?.coverage as { state?: string } | undefined;
  const emptyCurrent = page && !boardRows.length && !activeWork.length && !ownerAttention.length && !historyError && !observed.error;
  const footer = view.view === 'activity'
    ? feed.page && <RecordFooter className="center-footer"><span>{t('center.observedAgo', { time: ago(feed.page.observedAt) })}</span><span data-tone={coverage?.state === 'observed' ? undefined : 'warning'}>{coverageName(coverage?.state ?? 'unknown')}</span>
      <RecordDisclosure className="center-technical"><summary><Icon icon={ChevronDown} />{t('center.coverage')}</summary><pre>{JSON.stringify(feed.page.coverage, null, 2)}</pre></RecordDisclosure></RecordFooter>
    : page && <RecordFooter className="center-footer"><span>{t('center.observedAgo', { time: ago(page.observedAt) })}</span></RecordFooter>;
  const busy = (view.view === 'ax' ? ax.loading : reading || observed.loading || loadingHistory) || !!pendingAction;
  const runAction = async (action: string, run: () => Promise<unknown>) => { setPendingAction(action); try { await run(); } finally { setPendingAction(''); } };
  return <Panel initialFocus={initialFocus} title={t('center.title')} viewKey={view.view} busy={busy} footer={view.view === "ax" ? undefined : footer}
    headerNavigation={<div className="center-navigation"><SingleChoice tabs disabled={busy} label={t('center.view')} value={view.view} onChange={value => patch({ view: value as typeof view.view })} options={['current','activity','ax'].map(value => ({ value, label: value === 'ax' ? 'AX' : t(value === 'activity' ? 'center.activityView' : `center.${value}`) }))} /></div>}
    actions={<IconButton icon={RefreshCw} label={t('refresh')} busy={pendingAction === 'refresh' || !pendingAction && (view.view === 'ax' ? ax.loading : reading || observed.loading || loadingHistory)} disabled={busy} onClick={() => void runAction('refresh', async () => {
      if (view.view === 'ax') { await refreshAX(); return; }
      await Promise.allSettled([refreshBoard(), selected ? readRecord(selected) : Promise.resolve(), refreshConnector(), api<AgentActivitySnapshot>('agents/activity').then(acceptActivity), view.view === 'activity' ? readEvents() : showHistory ? readHistory() : Promise.resolve()]);
    })} />}
    onClose={() => { setSelected(undefined); axSelection.set(undefined); boardOpen.set(false); }} returnFocus="#board-trigger" onEscapeKeyDown={event => { if (view.view === 'ax' && axSelection.get()) { event.preventDefault(); axSelection.set(undefined); } else if (selected) { event.preventDefault(); closeRecord(); } }}><RecordSurface className="coordination-center" aria-busy={busy}>
    {view.view === 'ax' ? <AXPanel /> : <>
    <div className="center-filters">
      {view.view === 'current' && <SingleChoice compact form="content-pills" disabled={busy} label={t('center.filter')} value={view.filter} onChange={value => patch({ filter: value as typeof view.filter })} options={['all', 'attention', 'input', 'history'].map(value => ({ value, label: t(`center.${value}`) }))} />}
      <div className="center-resource"><SingleChoice dropdown compact disabled={busy} label={t('center.resourceFilter')} value={view.resource || 'all-resources'} onChange={resource => patch({ resource: resource === 'all-resources' ? '' : resource })} options={[{ value: 'all-resources', label: t('center.allResources') }, ...options.map(row => ({ value: row.key, label: row.label }))]} /></div>
    </div>
    {resourceError && <p role="status" className="center-note">{resourceError}</p>}
    {observed.error && <Notice tone="danger" title={t('center.unavailable')} actionBelow action={<Button busy={pendingAction === 'retry'} disabled={busy} onClick={() => void runAction('retry', refreshBoard)}>{t('retry')}</Button>}><p>{observed.error}</p></Notice>}
    <div className={`center-content ${selected ? 'has-detail' : ''}`}>
      {selected && recordDetail(selected)}<div className="center-list" data-empty={emptyCurrent || undefined}>{view.view === 'activity' ? <>
        <section aria-label={t('center.activityView')}>
          {feed.error && <Notice tone="danger" title={t(feed.reset ? 'center.gap' : 'center.unavailable')} actionBelow action={<Button busy={pendingAction === 'retry'} disabled={busy} onClick={() => void runAction('retry', () => readEvents(feed.reset ? 'reset' : 'refresh'))}>{t(feed.reset ? 'center.reset' : 'retry')}</Button>}><p>{feed.error}</p></Notice>}
          {feed.gap?.resource === view.resource && !feed.reset && <Notice tone="warning">{[t('center.retainedGap'), feed.gap.observedAt ? date(feed.gap.observedAt) : ''].filter(Boolean).join(' · ')}</Notice>}
          {!feed.rows.length && !reading && !feed.error && feed.page && <RecordEmpty className="center-empty" role="status"><Icon icon={Inbox} size={20} /><p>{t('center.emptyEvents')}</p></RecordEmpty>}
          {timeline(feed.resource === view.resource ? feed.rows : [])}
          <div className="center-more">
            {feed.page?.hasMore && <Button busy={pendingAction === 'more'} disabled={busy} onClick={() => void runAction('more', () => readEvents())}>{t('center.more')}</Button>}
            {feed.page && feed.historyCursor !== '' && <Button variant="ghost" busy={pendingAction === 'history'} disabled={busy} onClick={() => void runAction('history', () => readEvents('history'))}>{t('center.retainedHistory')}</Button>}
          </div>
        </section>
      </> : <>
        {historyError && <Notice tone="danger" action={<Button busy={pendingAction === 'retry-history'} disabled={busy} onClick={() => void runAction('retry-history', () => readHistory())}>{t('retry')}</Button>}>{historyError}</Notice>}
        {(ownerAttention.length > 0 || !attention.complete && !showHistory) && <Section label={t('center.attention')} count={ownerAttention.length} attention note={!attention.complete ? t('center.partial') : undefined}>
          {ownerAttention.map(attentionRow)}
        </Section>}
        {(activeWork.length > 0 || notices.length > 0) && <Section label={t(showHistory ? 'center.notices' : 'center.work')} count={activeWork.length + notices.length}>
          {activeWork.map(({ agent, session }) => <TaskCard key={`${agent}:${session.id}`} task={localTaskCard(agent, session, 'running')} form="detail" now={now}
            readTimeline={false}
            trigger={{ id: `work-${session.id}` }} onOpen={() => openTask(session.id, session.turnId ?? undefined, `work-${session.id}`)} />)}
          {notices.map(recordRow)}
        </Section>}
        {blockers.length > 0 && <Section label={t('center.blockers')} count={blockers.length}>{blockers.map(recordRow)}</Section>}
        {emptyCurrent && <RecordEmpty className="center-empty" role="status"><Icon icon={Inbox} size={20} /><p>{t(view.filter === 'all' || showHistory ? 'center.emptyBoard' : 'center.noAttention')}</p></RecordEmpty>}
        {showHistory && history?.nextCursor && <div className="center-more"><Button busy={pendingAction === 'more'} disabled={busy} onClick={() => void runAction('more', () => readHistory(history.nextCursor!))}>{t('center.more')}</Button></div>}
      </>}
    </div></div>
    </>}
  </RecordSurface></Panel>;
}

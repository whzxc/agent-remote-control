import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, CircleAlert, LoaderCircle, MessageSquare, RotateCcw, ShieldAlert } from 'lucide-react';
import { Button, Icon, Notice, Tooltip } from './index';
import { taskPhaseIcons } from './NodeCapsule';
import { activeHomepageTask, homepageTaskGroup, type HomepageTask, type TrackedActivity } from '../../state/activityModel';
import { taskExecution, taskExecutions, useTaskPreview } from '../../state/taskExecution';
import { executionStatus, terminalState } from '../../state/taskExecutionModel';
import { presentTaskState, recordedTimestamp, taskCardActivity, taskException, taskState, taskStatusEvidence, thoughtLine, toolSummary, type TaskSnapshotRow } from '../../state/taskProjection';
import { useRequestRouting } from '../../state/requestRouting';
import RecordedDispatchSpec from '../composites/RecordedDispatchSpec';
import { compactDuration } from '../../lib/duration';
import { projectLabelParts } from '../../lib/projectPath';
import { relativeTime } from '../../lib/relativeTime';
import { FilePath, ProjectLabel } from './ProjectPath';
import { useTaskOrigins } from './taskCardOrigins';
import { locale, t } from '../../i18n';
import type { AgentPhase } from '../../types';
import './TaskCard.css';

export type TaskCardData = Pick<HomepageTask, 'key' | 'agent' | 'session' | 'group'> &
  Partial<Pick<HomepageTask, 'activity' | 'deviceId' | 'controllerDeviceId' | 'sourceIds' | 'observedAt' | 'freshness' | 'stale' | 'startedAt' | 'endedAt'>>;
export const taskTitle = ({ session }: Pick<TaskCardData, 'session'>) => session.title || session.headline || session.id;

export function localTaskCard(agent: string, session: TrackedActivity, group = homepageTaskGroup(session, !!session.interaction, session.status ?? undefined, false)): TaskCardData {
  return { key: JSON.stringify([agent, session.id]), agent, session, group };
}

const phaseInk: Partial<Record<AgentPhase, string>> = {
  thinking: 'var(--phase-thinking)', tool: 'var(--phase-tool)', text: 'var(--phase-text)',
  command: 'var(--phase-command)', file: 'var(--phase-file)',
};
const SnapshotMarkdown = memo(function SnapshotMarkdown({ text }: { text: string }) {
  return <div className="task-snapshot-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}
    components={{ a: ({ children }) => <span>{children}</span> }}>{text}</ReactMarkdown></div>;
});

function SnapshotNote({ tone, label, text }: { tone: 'source' | 'request'; label?: string; text: string }) {
  if (tone === 'source') return <p className="task-snapshot-source">{text}</p>;
  return <div className="task-snapshot-request">
    {label && <span className="task-snapshot-request-label"><Icon icon={ShieldAlert} size={12} />{label}</span>}
    <p className="task-snapshot-request-text">{text}</p>
  </div>;
}

const SnapshotRows = memo(function SnapshotRows({ rows, project, request, limit }: { rows: TaskSnapshotRow[]; project?: string | null; request?: { label: string; text: string }; limit: number }) {
  const groups: TaskSnapshotRow[][] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (row.tool && group?.[0].tool && group[0].turnId === row.turnId) group.push(row);
    else groups.push([row]);
  }
  const latest = (matches: (row: TaskSnapshotRow) => boolean) => {
    for (let index = groups.length - 1; index >= 0; index--) {
      if (matches(groups[index][0])) return index;
    }
    return -1;
  };
  const reply = latest(row => row.role === 'agent' && row.final === true);
  const candidates = [
    reply < 0 ? latest(row => row.role === 'agent') : reply,
    latest(row => !!row.tool),
    latest(row => row.role === 'source'),
    latest(row => row.kind === 'thinking'),
  ];
  const selected = candidates.filter(index => index >= 0).slice(0, limit - Number(Boolean(request))).sort((a, b) => a - b);
  return <>{selected.map(index => {
    const group = groups[index];
    const first = group[0];
    if (first.role === 'source') return <SnapshotNote key={first.id} tone="source" text={first.text} />;
    if (first.role !== 'step') return <div key={first.id} className="task-snapshot-row" data-role={first.role}><SnapshotMarkdown text={first.text} /></div>;
    const latest = group.at(-1)!;
    const kind = first.tool ? 'tool' : latest.kind ?? 'running';
    const text = latest.kind === 'thinking' ? thoughtLine(latest.text) : latest.text.trim().split('\n', 1)[0];
    const { parts, more } = toolSummary(group.flatMap(row => row.tool ? [row.tool] : []));
    const labels = parts.map(({ kind, count }) => t(`detail.tools.${kind}`, { count }));
    if (more) labels.push(t('detail.tools.more', { count: more }));
    const path = latest.tool?.command ? undefined : latest.tool?.path;
    return <div key={first.id} className="task-snapshot-work" data-kind={kind}>
      <Icon icon={taskPhaseIcons[kind]} size={12} />
      {path ? <>
        {!!labels.length && <span className="task-snapshot-work-text task-snapshot-file-actions">{labels.join(' · ')} ·</span>}
        <FilePath path={path} project={project} cwd={latest.tool?.cwd} />
      </> : <span className="task-snapshot-work-text">{labels.length > 0 && <>{labels.join(' · ')} · </>}{text}</span>}
    </div>;
  })}{request && <SnapshotNote tone="request" {...request} />}</>;
});
type CardHeaderProps = {
  task: TaskCardData; now: number; onOpen?: () => void; description?: string; titleId?: string; heading?: boolean;
  trigger?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'id'> & { 'data-activity-session'?: string };
  spec?: ReactNode; duration?: number; attention?: boolean;
};

export function TaskCardScrollRow({ children, label }: { children: ReactNode; label?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = row.current, content = node?.firstElementChild;
    if (!node || !content) return;
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <div ref={row} className="task-card-scroll" role={overflow ? 'group' : undefined} tabIndex={overflow ? 0 : undefined} aria-label={overflow ? label : undefined}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      event.currentTarget.scrollBy({ left: event.key === 'ArrowLeft' ? -48 : 48 });
    }}>{children}</div>;
}

function TaskTime({ task, now, duration }: { task: TaskCardData; now: number; duration?: number }) {
  const language = locale.use();
  if (task.stale && task.session.turnDurationMs == null && !(task.session.turnEndedAt ?? task.endedAt)) {
    const seen = recordedTimestamp(task.freshness);
    if (seen === undefined) return null;
    const dateTime = new Date(seen).toISOString();
    const label = relativeTime(dateTime, now, language, t('device.now'));
    return <time className="task-card-duration" dateTime={dateTime} title={`${t('device.lastSeen')} ${label}`}>{label}</time>;
  }
  const live = activeHomepageTask(task);
  const start = recordedTimestamp(task.startedAt ?? task.session.turnStartedAt);
  const end = live ? task.deviceId ? recordedTimestamp(task.observedAt) : now : recordedTimestamp(task.endedAt ?? task.session.turnEndedAt) ?? task.session.endedAt;
  const elapsed = duration ?? (!live ? task.session.turnDurationMs : null) ?? (start !== undefined && end !== undefined ? end - start : NaN);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const label = compactDuration(elapsed);
  return <time className="task-card-duration" dateTime={`PT${Math.floor(elapsed / 1000)}S`} aria-label={`${t('duration')} ${label}`}>
    {label}
  </time>;
}

export function TaskCardHeader({ task, now, onOpen, trigger, description, titleId, heading, spec, duration, attention }: CardHeaderProps) {
  const origins = useTaskOrigins(task), title = taskTitle(task);
  const shownException = taskException(task.session.status);
  const dot = !shownException ? (task.group === 'needs-me' || attention ? 'warning' : task.group === 'unread' ? 'accent' : undefined) : undefined;
  const summary = task.session.dispatchSummary, tier = summary?.serviceTier?.trim();
  const hasPills = Boolean(spec || summary?.model?.trim() || summary?.effort?.trim() || (tier && tier !== 'default') || projectLabelParts(task.session.projectName, task.session.project));
  const hasMeta = hasPills || task.session.turnCount != null;
  const originLabel = origins.map(origin => origin.label).join(' → ');
  return <header className="task-card-header">
    <div className="task-card-first-row">
      <TaskCardScrollRow label={originLabel}><span className="task-card-origins" role="img" aria-label={originLabel}>
        {origins.map((origin, index) => <span key={`${index}:${origin.label}`}>{index > 0 && <Icon icon={ArrowRight} size={11} className="task-card-origin-arrow" />}<Tooltip text={[origin.label, origin.description].filter(Boolean).join(' · ')}><span className="task-card-origin-node"><span className="task-card-origin">{origin.graphic}</span>{origin.caption}</span></Tooltip></span>)}
      </span></TaskCardScrollRow>
      <div className="task-card-state-time">
        {shownException && <span className="task-card-exception" data-state={shownException} role="status">{t(`detail.state.${shownException}`)}</span>}
        {dot && <span className="task-card-dot" data-tone={dot} aria-hidden="true" />}
        <TaskTime task={task} now={now} duration={duration} />
      </div>
    </div>
    <TaskCardScrollRow label={title}>
      {heading ? <h2 id={titleId} className="task-card-title">{title}</h2>
        : onOpen || trigger?.disabled ? <button {...trigger} type="button" data-task-open className="task-card-title" title={title}
          aria-label={`${t('homepage.openDetail')}: ${title}`} aria-description={description} onClick={onOpen}>{title}</button>
        : <strong className="task-card-title">{title}</strong>}
    </TaskCardScrollRow>
    {hasMeta && <TaskCardScrollRow label={t('homepage.taskMetadata')}><div className="task-card-execution" data-pills={hasPills || undefined}>
      {spec ?? <RecordedDispatchSpec agent={task.deviceId ? undefined : task.agent} summary={task.session.dispatchSummary} />}
      <ProjectLabel name={task.session.projectName} path={task.session.project} />
      {task.session.turnCount != null && <span className="task-card-turns">{t('timeline.turnCount', { count: task.session.turnCount })}</span>}
    </div></TaskCardScrollRow>}
  </header>;
}

export function EmptyTaskBody({ state, action, onAction }: { state: 'loading' | 'error' | 'empty'; action?: string; onAction?: () => void }) {
  return <div className="task-empty-body">
    <span role="status"><Icon icon={state === 'loading' ? LoaderCircle : state === 'error' ? CircleAlert : MessageSquare} size={14} />{t(`homepage.preview.${state}`)}</span>
    {action && onAction && <Button variant="link" onClick={onAction}><Icon icon={state === 'error' || action === t('homepage.reload') ? RotateCcw : ArrowRight} size={14} />{action}</Button>}
  </div>;
}

type CardNotice = { text: string; danger?: boolean };
function TaskCardPreview({ task, now, rows, notice, limit, pending, failed, retry, onOpen }: {
  task: TaskCardData; now: number; rows: TaskSnapshotRow[]; notice?: CardNotice; limit: number;
  pending: boolean; failed: boolean; retry: () => void; onOpen?: () => void;
}) {
  const interaction = task.group === 'needs-me' ? task.session.interaction : undefined;
  const { routing, error } = useRequestRouting(task.agent, task.session.id, task.deviceId ? undefined : interaction);
  const source = task.session.origin?.sourceLabel || task.session.dispatchSummary?.controlSource?.label || t('homepage.controller');
  const route = routing ? t(routing.state === 'deferred' ? 'routing.countdown' : routing.state === 'paused' ? 'routing.paused'
    : routing.state === 'not-routable' ? 'routing.nextCheck' : 'routing.routed', { source, seconds: Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000)) }) : undefined;
  const request = interaction && { label: error || route || t('homepage.requestTo', { source }), text: interaction.summary };
  const headline = task.session.headline || task.session.fallbackHeadline;
  const hasRows = rows.some(row => row.role !== 'request');
  const hasPreview = hasRows || !!request || (!!headline && !failed);
  const state = failed ? 'error' : pending ? 'loading' : 'empty';
  return <div className="task-snapshot-timeline" data-empty={!hasPreview || undefined} role="region" aria-label={t('homepage.recentSteps')}>
    {hasPreview ? <div className="task-snapshot-tail">
      {!hasRows && headline && <div className="task-snapshot-row" data-role="agent"><SnapshotMarkdown text={headline} /></div>}
      <SnapshotRows rows={rows} project={task.session.project} request={request} limit={limit} />
      {failed && <Button variant="link" onClick={retry}><Icon icon={RotateCcw} size={14} />{t('retry')}</Button>}
    </div> : <EmptyTaskBody state={state} action={failed ? t('retry') : pending ? undefined : t('homepage.viewDetail')} onAction={failed ? retry : onOpen} />}
    {notice && (notice.danger ? <Notice layout="inline">{notice.text}</Notice> : <p className="task-snapshot-routing" role="status">{notice.text}</p>)}
  </div>;
}

export function TaskCard({ task, now, form, onOpen, trigger, description, snapshotKey, notice, attention, footer, readTimeline = true }: Omit<CardHeaderProps, 'titleId' | 'heading' | 'spec' | 'duration'> & {
  form: 'summary' | 'detail'; snapshotKey?: string; notice?: CardNotice; footer?: ReactNode; readTimeline?: boolean;
}) {
  const card = useRef<HTMLElement>(null);
  const detail = form === 'detail';
  const execution = useSyncExternalStore(taskExecutions.subscribe, () => task.deviceId ? undefined : taskExecution(task.agent, task.session.id));
  const turn = task.session.selectedTurnId ?? task.session.turnId;
  const timing = execution?.turnTimings?.[turn ?? execution.turnId ?? ''];
  const summary = turn ? execution?.turnDispatchSummaries?.[turn] ?? (execution?.turnId === turn ? execution.dispatchSummary : undefined) : execution?.dispatchSummary;
  const cachedStatus = executionStatus(execution, turn);
  const recordedStatus = !task.session.selectedTurnId || task.session.selectedTurnId === task.session.turnId ? task.session.status : undefined;
  const status = taskStatusEvidence(cachedStatus, recordedStatus);
  const state = presentTaskState(status, activeHomepageTask(task), task.group === 'needs-me');
  const settled = !activeHomepageTask(task) && terminalState(taskState(status, false));
  const canRead = readTimeline && detail && !task.deviceId && !!task.session.timeline;
  const preview = useTaskPreview(task.agent, task.session.id, canRead, card, settled, turn);
  const presentation = {
    ...task, startedAt: timing?.startedAt ?? task.startedAt, endedAt: timing?.endedAt ?? task.endedAt,
    group: state === 'failed' || state === 'interrupted' ? task.group === 'unread' ? 'unread' as const : 'recent' as const : task.group,
    session: { ...task.session, status, dispatchSummary: summary ? { ...task.session.dispatchSummary, ...summary } : task.session.dispatchSummary },
  };
  const entries = execution?.entries, snapshot = task.activity?.snapshot, selectedTurn = task.session.selectedTurnId;
  const rows = useMemo(() => (snapshot?.length && !selectedTurn ? snapshot : undefined) ?? (detail && entries
    ? taskCardActivity(selectedTurn ? entries.filter(entry => entry.turnId === selectedTurn) : entries).snapshot
    : []), [snapshot, detail, entries, selectedTurn]);
  const aurora = detail && state === 'running', phase = task.session.phase;
  const title = taskTitle(task);
  const phaseDescription = aurora && phaseInk[phase] ? t(`activity.phase.${phase}`) : undefined;
  return <article ref={card} className="task-card" aria-label={title} aria-description={phaseDescription ?? description ?? t(`detail.state.${state}`)} data-task-snapshot={snapshotKey}
    data-form={form} data-offline={task.stale || undefined} data-waiting={!aurora && detail && presentation.group === 'needs-me' || undefined} data-aurora={aurora ? phase : undefined}
    style={aurora ? { '--task-aurora-ink': phaseInk[phase] ?? 'var(--role-agent)' } as CSSProperties : undefined}
    onClick={onOpen && !trigger?.disabled ? event => {
      if (!(event.target instanceof Element) || event.target.closest('button, [tabindex="0"], a') || window.getSelection()?.toString()) return;
      onOpen();
    } : undefined}>
    <TaskCardHeader task={presentation} now={now} attention={attention} description={description ?? t(`detail.state.${state}`)} onOpen={onOpen} trigger={trigger} />
    {detail && <TaskCardPreview task={presentation} now={now} rows={rows} notice={notice} limit={footer ? 3 : 4}
      failed={preview.failed} retry={preview.retry} pending={canRead && !execution} onOpen={onOpen} />}
    {footer}
  </article>;
}

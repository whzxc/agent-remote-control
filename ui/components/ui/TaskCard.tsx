import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRightLeft, ChevronRight } from 'lucide-react';
import { Icon, Notice, Tooltip } from './index';
import { taskPhaseIcons } from './NodeCapsule';
import { activeHomepageTask, homepageTaskGroup, type HomepageTask, type TrackedActivity } from '../../state/activityModel';
import { taskExecution, taskExecutions, useTaskPreview } from '../../state/taskExecution';
import { executionStatus, terminalState } from '../../state/taskExecutionModel';
import { recordedTimestamp, taskCardActivity, taskState, thoughtLine, toolSummary, type TaskSnapshotRow } from '../../state/taskProjection';
import { useRequestRouting } from '../../state/requestRouting';
import RecordedDispatchSpec from '../composites/RecordedDispatchSpec';
import { compactDuration } from '../../lib/duration';
import { relativeTime } from '../../lib/relativeTime';
import { FilePath, ProjectLabel } from './ProjectPath';
import { useTaskOrigins } from './taskCardOrigins';
import { locale, t } from '../../i18n';
import type { AgentPhase } from '../../types';
import './TaskCard.css';

export type TaskCardData = Pick<HomepageTask, 'key' | 'agent' | 'session' | 'group'> &
  Partial<Pick<HomepageTask, 'activity' | 'deviceId' | 'controllerDeviceId' | 'sourceIds' | 'accountId' | 'observedAt' | 'freshness' | 'startedAt' | 'endedAt'>>;
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

const SnapshotRows = memo(function SnapshotRows({ rows, project }: { rows: TaskSnapshotRow[]; project?: string | null }) {
  const groups: TaskSnapshotRow[][] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (row.tool && group?.[0].tool && group[0].turnId === row.turnId) group.push(row);
    else groups.push([row]);
  }
  return groups.map(group => {
    const first = group[0];
    if (first.role !== 'step') return <div key={first.id} className="task-snapshot-row" data-role={first.role}><SnapshotMarkdown text={first.text} /></div>;
    const latest = group.at(-1)!;
    const text = latest.kind === 'thinking' ? thoughtLine(latest.text) : latest.text.trim().split('\n', 1)[0];
    const { parts, more } = toolSummary(group.flatMap(row => row.tool ? [row.tool] : []));
    const labels = parts.map(({ kind, count }) => t(`detail.tools.${kind}`, { count }));
    if (more) labels.push(t('detail.tools.more', { count: more }));
    const path = latest.tool?.command ? undefined : latest.tool?.path;
    return <div key={first.id} className="task-snapshot-work">
      <Icon icon={taskPhaseIcons[latest.kind ?? 'running']} size={12} />
      {path ? <>
        {!!labels.length && <span className="task-snapshot-work-text task-snapshot-file-actions">{labels.join(' · ')} ·</span>}
        <FilePath path={path} project={project} cwd={latest.tool?.cwd} />
      </> : <span className="task-snapshot-work-text">{labels.length > 0 && <>{labels.join(' · ')} · </>}{text}</span>}
    </div>;
  });
});
type CardHeaderProps = {
  task: TaskCardData; now: number; onOpen?: () => void; description?: string; titleId?: string; heading?: boolean;
  trigger?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'id'> & { 'data-activity-session'?: string };
  spec?: ReactNode; duration?: number;
};

function ScrollRow({ children, label }: { children: ReactNode; label?: string }) {
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
  if (task.group === 'unconfirmed') {
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

export function TaskCardHeader({ task, now, onOpen, trigger, description, titleId, heading, spec, duration }: CardHeaderProps) {
  const origins = useTaskOrigins(task), title = taskTitle(task);
  const originLabel = origins.map(origin => origin.label).join(' → ');
  return <header className="task-card-header">
    <div className="task-card-first-row">
      <ScrollRow label={originLabel}><span className="task-card-origins" role="img" aria-label={originLabel}>
        {origins.map((origin, index) => <span key={`${index}:${origin.label}`}>{index > 0 && <Icon icon={ChevronRight} size={10} />}<Tooltip text={[origin.label, origin.description].filter(Boolean).join(' · ')}><span className="task-card-origin">{origin.graphic}</span></Tooltip></span>)}
      </span></ScrollRow>
      <TaskTime task={task} now={now} duration={duration} />
    </div>
    <ScrollRow label={title}>
      {heading ? <h2 id={titleId} className="task-card-title">{title}</h2>
        : onOpen || trigger?.disabled ? <button {...trigger} type="button" data-task-open className="task-card-title" title={title}
          aria-label={`${t('homepage.openDetail')}: ${title}`} aria-description={description} onClick={onOpen}>{title}</button>
        : <strong className="task-card-title">{title}</strong>}
    </ScrollRow>
    <ScrollRow label={t('homepage.taskMetadata')}><div className="task-card-execution">
      {spec ?? <RecordedDispatchSpec agent={task.deviceId ? undefined : task.agent} summary={task.session.dispatchSummary} />}
      <ProjectLabel name={task.session.projectName} path={task.session.project} />
      {task.session.turnCount != null && <span className="task-card-turns">{t('timeline.turnCount', { count: task.session.turnCount })}</span>}
    </div></ScrollRow>
  </header>;
}

type CardNotice = { text: string; danger?: boolean };
function TaskCardPreview({ task, now, rows, notice }: { task: TaskCardData; now: number; rows: TaskSnapshotRow[]; notice?: CardNotice }) {
  const waiting = task.group === 'needs-me';
  const { routing, error } = useRequestRouting(task.agent, task.session.id, !task.deviceId && waiting ? task.session.interaction : undefined);
  const source = task.session.origin?.sourceLabel || task.session.dispatchSummary?.controlSource?.label || t('homepage.controller');
  const route = routing ? t(routing.state === 'deferred' ? 'routing.countdown' : routing.state === 'paused' ? 'routing.paused'
    : routing.state === 'not-routable' ? 'routing.nextCheck' : 'routing.routed', { source, seconds: Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000)) }) : undefined;
  const headline = task.session.headline || task.session.fallbackHeadline;
  return <div className="task-snapshot-timeline" role="region" aria-label={t('homepage.recentSteps')}>
    <div className="task-snapshot-tail">
      {rows.length ? <SnapshotRows rows={rows} project={task.session.project} /> : headline && <div className="task-snapshot-row" data-role="agent"><SnapshotMarkdown text={headline} /></div>}
      {waiting && task.session.interaction && !rows.some(row => row.role === 'request') && <div className="task-snapshot-row" data-role="request">{task.session.interaction.summary}</div>}
      {waiting && task.session.interaction && <span className="task-snapshot-routing"><Icon icon={ArrowRightLeft} size={12} />{error || route || t('homepage.requestTo', { source })}</span>}
      {notice && (notice.danger ? <Notice layout="inline">{notice.text}</Notice> : <p className="task-snapshot-routing" role="status">{notice.text}</p>)}
    </div>
  </div>;
}

export function TaskCard({ task, now, form, onOpen, trigger, description, snapshotKey, notice }: Omit<CardHeaderProps, 'titleId' | 'heading' | 'spec' | 'duration'> & {
  form: 'summary' | 'detail'; snapshotKey?: string; notice?: CardNotice;
}) {
  const card = useRef<HTMLElement>(null);
  const detail = form === 'detail';
  const execution = useSyncExternalStore(taskExecutions.subscribe, () => task.deviceId ? undefined : taskExecution(task.agent, task.session.id));
  const turn = task.session.selectedTurnId ?? task.session.turnId;
  const timing = execution?.turnTimings?.[turn ?? execution.turnId ?? ''];
  const summary = turn ? execution?.turnDispatchSummaries?.[turn] ?? (execution?.turnId === turn ? execution.dispatchSummary : undefined) : execution?.dispatchSummary;
  const status = executionStatus(execution, turn);
  const settled = !activeHomepageTask(task) && terminalState(taskState(status, false));
  useTaskPreview(task.agent, task.session.id, detail && !task.deviceId && !!task.session.timeline && !settled, card);
  const presentation = {
    ...task, startedAt: timing?.startedAt ?? task.startedAt, endedAt: timing?.endedAt ?? task.endedAt,
    session: summary ? { ...task.session, dispatchSummary: { ...task.session.dispatchSummary, ...summary } } : task.session,
  };
  const entries = execution?.entries, snapshot = task.activity?.snapshot, selectedTurn = task.session.selectedTurnId;
  const rows = useMemo(() => snapshot ?? (detail && entries
    ? taskCardActivity(selectedTurn ? entries.filter(entry => entry.turnId === selectedTurn) : entries).snapshot
    : []), [snapshot, detail, entries, selectedTurn]);
  const aurora = detail && task.group === 'running', phase = task.session.phase;
  const title = taskTitle(task);
  const phaseDescription = aurora && phaseInk[phase] ? t(`activity.phase.${phase}`) : undefined;
  return <article ref={card} className="task-card" aria-label={title} aria-description={phaseDescription ?? description} data-task-snapshot={snapshotKey}
    data-form={form} data-offline={task.deviceId && task.group === 'unconfirmed' || undefined} data-aurora={aurora ? phase : undefined}
    style={aurora ? { '--task-aurora-ink': phaseInk[phase] ?? 'var(--role-agent)' } as CSSProperties : undefined}
    onClick={onOpen && !trigger?.disabled ? event => {
      if (!(event.target instanceof Element) || event.target.closest('button, [tabindex="0"], a') || window.getSelection()?.toString()) return;
      onOpen();
    } : undefined}>
    <TaskCardHeader task={presentation} now={now} description={description} onOpen={onOpen} trigger={trigger} />
    {detail && <TaskCardPreview task={presentation} now={now} rows={rows} notice={notice} />}
  </article>;
}

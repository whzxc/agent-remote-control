import { memo, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { taskExecution, useTaskPreview } from '../../state/taskExecution';
import { executionStatus, terminalState } from '../../state/taskExecutionModel';
import { ArrowRightLeft, Check, ChevronRight, CircleHelp, Hourglass } from 'lucide-react';
import { Icon, IconButton, Tooltip } from './index';
import { taskPhaseIcons } from './NodeCapsule';
import { activeHomepageTask, type HomepageTask } from '../../state/activityModel';
import { recordedTimestamp, taskState, thoughtLine, toolSummary, type TaskSnapshotRow } from '../../state/taskProjection';
import { useRequestRouting } from '../../state/requestRouting';
import RecordedDispatchSpec from '../composites/RecordedDispatchSpec';
import { SourceMark } from '../activity';
import { compactDuration } from '../../lib/duration';
import { TaskBubble, TaskBubbleCopy } from './TaskRow';
import { FilePath, ProjectLabel } from './ProjectPath';
import { t } from '../../i18n';
import './TaskSnapshot.css';

export type TaskOrigin = { label: string; graphic: ReactNode };
export type TaskIdentity = { agent: TaskOrigin; source?: TaskOrigin };
export const taskTitle = (task: HomepageTask) => task.session.title || task.session.headline || task.session.id;
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
function status(task: HomepageTask) {
  if (task.group === 'unconfirmed') return 'unconfirmed';
  if (task.group === 'needs-me') return task.session.interaction?.kind === 'question' ? 'needsInput' : 'approvalRequired';
  if (task.group === 'running') return task.activity.steps.at(-1)?.kind ?? 'running';
  return task.session.status === 'failed' ? 'failed' : ['cancelled', 'interrupted'].includes(task.session.status ?? '') ? 'interrupted' : 'completed';
}
function TaskIdentityMark({ agent, source }: TaskIdentity) {
  return <span className="task-card-identity" role="img" aria-label={[agent.label, source?.label].filter(Boolean).join(' · ')}>
    {agent.graphic}{source && <SourceMark label={source.label}>{source.graphic}</SourceMark>}
  </span>;
}
function TaskElapsed({ task, now }: { task: HomepageTask; now: number }) {
  if (task.group === 'unconfirmed') return null;
  const live = activeHomepageTask(task);
  const start = recordedTimestamp(task.startedAt);
  const end = live ? task.deviceId ? recordedTimestamp(task.observedAt) : now : recordedTimestamp(task.endedAt);
  const elapsed = (!live ? task.session.turnDurationMs : null) ?? (start !== undefined && end !== undefined ? end - start : NaN);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return <time className="task-card-duration" dateTime={`PT${Math.floor(elapsed / 1000)}S`} aria-label={t('duration')}>
    {compactDuration(elapsed)}
  </time>;
}
export function TaskHistorySummary({ task, identity, freshness, now, onOpen }: {
  task: HomepageTask; identity: TaskIdentity; freshness?: string; now: number; onOpen: () => void;
}) {
  const state = status(task), title = taskTitle(task);
  return <div className="task-history-summary" data-task-snapshot={task.key}>
    <TaskBubble data-task-open
      aria-label={`${t('homepage.openDetail')}: ${title}`} onClick={onOpen}>
      <TaskIdentityMark {...identity} />
      <TaskBubbleCopy title={title}>
        <span className="activity-phase">
          <span>{t(`homepage.${state}`)}</span>
          <ProjectLabel name={task.session.projectName} path={task.session.project} />
          {task.group === 'unconfirmed' && freshness && <span className="task-history-meta" title={freshness}>{freshness}</span>}
        </span>
        <span className="task-card-execution">
          <RecordedDispatchSpec agent={task.deviceId ? undefined : task.agent} summary={task.session.dispatchSummary} />
          <TaskElapsed task={task} now={now} />
        </span>
      </TaskBubbleCopy>
    </TaskBubble>
  </div>;
}
function TaskStatusMark({ task, now }: { task: HomepageTask; now: number }) {
  const state = status(task), offline = task.group === 'unconfirmed', waiting = task.group === 'needs-me';
  const icon = offline ? CircleHelp : waiting ? Hourglass : activeHomepageTask(task) ? taskPhaseIcons[task.activity.steps.at(-1)?.kind ?? 'running'] : undefined;
  return <span className="task-status-mark" data-tone={offline ? 'neutral' : waiting ? 'warning' : 'command'}>
    {icon && <Icon icon={icon} size={12} />}
    <span className="task-status-label">{t(`homepage.${state}`)}</span><TaskElapsed task={task} now={now} />
  </span>;
}

export function TaskSnapshot({ task, origins, now, path, freshness, onOpen, onRead }: {
  task: HomepageTask; origins: TaskOrigin[]; now: number; path?: string; freshness?: string;
  onOpen?: () => void; onRead?: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const cachedStatus = executionStatus(taskExecution(task.agent, task.session.id), task.session.turnId);
  const settled = !activeHomepageTask(task) && terminalState(taskState(cachedStatus, false));
  useTaskPreview(task.agent, task.session.id, !task.deviceId && !!task.session.timeline && !settled, card);
  const offline = task.group === 'unconfirmed', waiting = task.group === 'needs-me';
  const { routing, error } = useRequestRouting(task.agent, task.session.id, !task.deviceId && waiting ? task.session.interaction : undefined);
  const source = origins[0]?.label ?? t('homepage.controller');
  const route = routing ? t(routing.state === 'deferred' ? 'routing.countdown' : routing.state === 'paused' ? 'routing.paused'
    : routing.state === 'not-routable' ? 'routing.nextCheck' : 'routing.routed', { source, seconds: Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000)) }) : undefined;
  const { snapshot } = task.activity;
  const title = taskTitle(task);
  return <div ref={card} className="task-snapshot" data-task-snapshot={task.key} data-offline={offline || undefined}>
    <header><span className="task-snapshot-origins" role="img" aria-label={origins.map(origin => origin.label).join(' → ')}>
      {origins.map((origin, index) => <span key={`${index}:${origin.label}`}>{index > 0 && <Icon icon={ChevronRight} size={10} />}<Tooltip text={origin.label}><span className="task-snapshot-origin">{origin.graphic}</span></Tooltip></span>)}
    </span><TaskStatusMark task={task} now={now} />
      {onRead && task.group === 'unread' && <IconButton className="task-snapshot-read" compact icon={Check} label={`${t('homepage.markRead')}: ${title}`} onClick={onRead} />}
    </header>
    {onOpen ? <button type="button" data-task-open className="task-snapshot-title" title={title} aria-label={`${t('homepage.openDetail')}: ${title}`} onClick={onOpen}>{title}</button>
      : <strong className="task-snapshot-title">{title}</strong>}
    <div className="task-card-execution task-snapshot-execution">
      <RecordedDispatchSpec agent={task.deviceId ? undefined : task.agent} summary={task.session.dispatchSummary} />
      <ProjectLabel name={task.session.projectName} path={task.session.project} />
      {!offline && path && <span className="task-snapshot-connection" title={path}>{path}</span>}
    </div>
    <div className="task-snapshot-timeline" role="region" aria-label={t('homepage.recentSteps')}>
      <div className="task-snapshot-tail">
        {snapshot.length ? <SnapshotRows rows={snapshot} project={task.session.project} /> : task.session.headline || task.session.fallbackHeadline ? <div className="task-snapshot-row" data-role="agent"><SnapshotMarkdown text={task.session.headline || task.session.fallbackHeadline || ''} /></div> : null}
        {waiting && !snapshot.some(row => row.role === 'request') && <div className="task-snapshot-row" data-role="request"><span>{task.session.interaction?.summary}</span></div>}
        {waiting && <span className="task-snapshot-routing"><Icon icon={ArrowRightLeft} size={12} />{error || route || t('homepage.requestTo', { source })}</span>}
        {offline && freshness && <span className="task-snapshot-observed">{freshness}</span>}
      </div>
    </div>
  </div>;
}

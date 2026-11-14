import { memo, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTaskPreview } from '../../state/taskExecution';
import { ArrowRightLeft, Check, ChevronRight, CircleHelp, Hourglass } from 'lucide-react';
import { Icon, IconButton, Tile, Tooltip } from './index';
import { taskPhaseIcons } from './NodeCapsule';
import type { HomepageTask } from '../../state/activityModel';
import { recordedTimestamp, thoughtLine, type TaskSnapshotRow } from '../../state/taskProjection';
import { useRequestRouting } from '../../state/requestRouting';
import { t } from '../../i18n';
import './TaskSnapshot.css';

export type TaskOrigin = { label: string; graphic: ReactNode };
export const taskTitle = (task: HomepageTask) => task.session.title || task.session.headline || task.session.id;
const SnapshotMarkdown = memo(function SnapshotMarkdown({ text }: { text: string }) {
  return <div className="task-snapshot-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}
    components={{ a: ({ children }) => <span>{children}</span> }}>{text}</ReactMarkdown></div>;
});

const SnapshotRows = memo(function SnapshotRows({ rows }: { rows: TaskSnapshotRow[] }) {
  const groups: TaskSnapshotRow[][] = [];
  for (const row of rows) {
    const group = groups.at(-1);
    if (row.role === 'step' && group?.[0].role === 'step' && group[0].turnId === row.turnId) group.push(row);
    else groups.push([row]);
  }
  return groups.map(group => {
    const first = group[0];
    if (first.role !== 'step') return <div key={first.id} className="task-snapshot-row" data-role={first.role}><SnapshotMarkdown text={first.text} /></div>;
    const latest = group.at(-1)!;
    const text = latest.kind === 'thinking' ? thoughtLine(latest.text) : latest.text.trim().split('\n', 1)[0];
    return <div key={first.id} className="task-snapshot-work" data-status={latest.status}>
      <Icon icon={taskPhaseIcons[latest.kind ?? 'running']} size={12} />
      <span className="task-snapshot-work-count">{t('detail.process.actions', { count: group.length })}</span>
      <span className="task-snapshot-work-text">{text}</span>
    </div>;
  });
});
function status(task: HomepageTask) {
  if (task.group === 'unconfirmed') return 'unconfirmed';
  if (task.group === 'needs-me') return task.session.interaction?.kind === 'question' ? 'needsInput' : 'approvalRequired';
  if (task.group === 'running') return task.activity.steps.at(-1)?.kind ?? 'running';
  return task.session.status === 'failed' ? 'failed' : ['cancelled', 'interrupted'].includes(task.session.status ?? '') ? 'interrupted' : 'completed';
}
export function TaskStatusMark({ task, now }: { task: HomepageTask; now: number }) {
  const state = status(task), offline = task.group === 'unconfirmed', waiting = task.group === 'needs-me';
  const start = recordedTimestamp(task.startedAt);
  const live = task.group === 'running' || waiting;
  const end = live ? task.deviceId ? recordedTimestamp(task.observedAt) : now : recordedTimestamp(task.endedAt);
  const seconds = start !== undefined && end !== undefined && end >= start ? Math.floor((end - start) / 1000) : undefined;
  return <div className="task-status-mark" aria-label={t(`homepage.${state}`)}>
    <Tile icon={offline ? CircleHelp : waiting ? Hourglass : task.group === 'running' ? taskPhaseIcons[task.activity.steps.at(-1)?.kind ?? 'running'] : Check}
      form="phase" tone={offline ? 'neutral' : waiting ? 'warning' : task.group === 'running' ? 'command' : 'success'} />
    <span>{t(`homepage.${state}`)}{!offline && seconds !== undefined && <time aria-label={t('duration')}> · {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</time>}</span>
  </div>;
}

export function TaskSnapshot({ task, origins, now, path, freshness, onOpen, onRead, tabbable = true }: {
  task: HomepageTask; origins: TaskOrigin[]; now: number; path?: string; freshness?: string;
  onOpen?: () => void; onRead?: () => void; tabbable?: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  useTaskPreview(task.agent, task.session.id, !task.deviceId && !!task.session.timeline, card);
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
    </span>{!offline && path && <span className="task-snapshot-path" title={path}>{path}</span>}
      {onRead && task.group === 'unread' && <IconButton className="task-snapshot-read" compact icon={Check} label={`${t('homepage.markRead')}: ${title}`} onClick={onRead} />}
    </header>
    {onOpen ? <button tabIndex={tabbable ? undefined : -1} className="task-snapshot-title" title={title} aria-label={`${t('homepage.openDetail')}: ${title}`} onClick={onOpen}>{title}</button>
      : <strong className="task-snapshot-title">{title}</strong>}
    {task.session.project && <span className="task-snapshot-project" title={task.session.project}>{task.session.project}</span>}
    <div className="task-snapshot-timeline" role="region" aria-label={t('homepage.recentSteps')}>
      <div className="task-snapshot-tail">
        {snapshot.length ? <SnapshotRows rows={snapshot} /> : task.session.headline || task.session.fallbackHeadline ? <div className="task-snapshot-row" data-role="agent"><SnapshotMarkdown text={task.session.headline || task.session.fallbackHeadline || ''} /></div> : null}
        {waiting && !snapshot.some(row => row.role === 'request') && <div className="task-snapshot-row" data-role="request"><span>{task.session.interaction?.summary}</span></div>}
        {waiting && <span className="task-snapshot-routing"><Icon icon={ArrowRightLeft} size={12} />{error || route || t('homepage.requestTo', { source })}</span>}
        {offline && freshness && <span className="task-snapshot-observed">{freshness}</span>}
      </div>
    </div>
  </div>;
}

import type { ReactNode } from 'react';
import { useTaskPreview } from '../../state/taskExecution';
import { ArrowRightLeft, Check, ChevronRight, CircleHelp, Hourglass, ListChecks } from 'lucide-react';
import { Icon, IconButton, Tile, Tooltip } from './index';
import { taskPhaseIcons } from './NodeCapsule';
import type { HomepageTask } from '../../state/activityModel';
import { recordedTimestamp } from '../../state/taskProjection';
import { useRequestRouting } from '../../state/requestRouting';
import { t } from '../../i18n';
import './TaskSnapshot.css';

export type TaskOrigin = { label: string; graphic: ReactNode };
export const taskTitle = (task: HomepageTask) => task.session.title || task.session.headline || task.session.id;
function status(task: HomepageTask) {
  if (task.group === 'unconfirmed') return 'unconfirmed';
  if (task.group === 'needs-me') return task.session.interaction?.kind === 'question' ? 'needsInput' : 'approvalRequired';
  if (task.group === 'running') return task.activity.steps.at(-1)?.kind ?? 'running';
  return task.session.status === 'failed' ? 'failed' : ['cancelled', 'interrupted'].includes(task.session.status ?? '') ? 'interrupted' : 'completed';
}
export function TaskStatusMark({ task, now }: { task: HomepageTask; now: number }) {
  const state = status(task), offline = task.group === 'unconfirmed', waiting = task.group === 'needs-me';
  const start = recordedTimestamp(task.startedAt);
  const end = recordedTimestamp(task.endedAt) ?? task.session.endedAt
    ?? (task.group === 'running' || waiting ? task.deviceId ? recordedTimestamp(task.observedAt) : now : undefined);
  const seconds = start !== undefined && end !== undefined && end >= start ? Math.floor((end - start) / 1000) : undefined;
  return <div className="task-status-mark" aria-label={t(`homepage.${state}`)}>
    <Tile icon={offline ? CircleHelp : waiting ? Hourglass : task.group === 'running' ? taskPhaseIcons[task.activity.steps.at(-1)?.kind ?? 'running'] : Check}
      form="phase" tone={offline ? 'neutral' : waiting ? 'warning' : task.group === 'running' ? 'command' : 'success'} />
    <span>{t(`homepage.${state}`)}{!offline && seconds !== undefined && <time> · {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</time>}</span>
  </div>;
}

export function TaskSnapshot({ task, origins, now, path, freshness, onOpen, onRead, tabbable = true }: {
  task: HomepageTask; origins: TaskOrigin[]; now: number; path?: string; freshness?: string;
  onOpen?: () => void; onRead: () => void; tabbable?: boolean;
}) {
  useTaskPreview(task.agent, task.session.id, !task.deviceId && !!task.session.timeline);
  const offline = task.group === 'unconfirmed', waiting = task.group === 'needs-me';
  const { routing, error } = useRequestRouting(task.agent, task.session.id, !task.deviceId && waiting ? task.session.interaction : undefined);
  const source = origins[0]?.label ?? t('homepage.controller');
  const route = routing ? t(routing.state === 'deferred' ? 'routing.countdown' : routing.state === 'paused' ? 'routing.paused'
    : routing.state === 'not-routable' ? 'routing.nextCheck' : 'routing.routed', { source, seconds: Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000)) }) : undefined;
  const { plan, change, snapshot = [] } = task.activity;
  const title = taskTitle(task);
  return <div className="task-snapshot" data-task-snapshot={task.key} data-offline={offline || undefined}>
    <header><span className="task-snapshot-origins" role="img" aria-label={origins.map(origin => origin.label).join(' → ')}>
      {origins.map((origin, index) => <span key={`${index}:${origin.label}`}>{index > 0 && <Icon icon={ChevronRight} size={10} />}<Tooltip text={origin.label}><span className="task-snapshot-origin">{origin.graphic}</span></Tooltip></span>)}
    </span>{!offline && path && <span className="task-snapshot-path" title={path}>{path}</span>}</header>
    {onOpen ? <button tabIndex={tabbable ? undefined : -1} className="task-snapshot-title" aria-label={`${t('homepage.openDetail')}: ${title}`} onClick={onOpen}>{title}</button>
      : <strong className="task-snapshot-title">{title}</strong>}
    {task.session.project && <span className="task-snapshot-project" title={task.session.project}>{task.session.project}</span>}
    <div className="task-snapshot-timeline" aria-label={t('homepage.recentSteps')}>
      <div className="task-snapshot-tail">
        {snapshot.length ? snapshot.map((row, index) => <div key={index} className="task-snapshot-row" data-role={row.role} data-status={row.status}>
          {row.role === 'step' && <Icon icon={taskPhaseIcons[row.kind ?? 'running']} size={12} />}
          <span>{row.text}</span>
        </div>) : task.session.headline || task.session.fallbackHeadline ? <div className="task-snapshot-row" data-role="agent"><span>{task.session.headline || task.session.fallbackHeadline}</span></div> : null}
        {waiting && !snapshot.some(row => row.role === 'request') && <div className="task-snapshot-row" data-role="request"><span>{task.session.interaction?.summary}</span></div>}
        {waiting && <span className="task-snapshot-routing"><Icon icon={ArrowRightLeft} size={12} />{t('homepage.requestTo', { source })}</span>}
        {task.partial && <span className="task-snapshot-observed">{t('homepage.partial')}</span>}
        {offline && <span className="task-snapshot-observed">{freshness}</span>}
      </div>
    </div>
    <footer>
      {waiting ? <span title={error || route}><Icon icon={ArrowRightLeft} size={14} />{error || route || t('homepage.requestTo', { source })}</span>
        : offline ? <span>{freshness}</span>
        : plan ? <span><Icon icon={ListChecks} size={14} />{t('homepage.plan')} {plan.completed}/{plan.total}<span title={plan.current}>{plan.current}</span></span>
        : change ? <span title={change.summary}>{change.summary}{change.added !== undefined && <em>+{change.added}</em>}{change.removed !== undefined && <em>−{change.removed}</em>}</span> : null}
      {task.group === 'unread' && <IconButton tabIndex={tabbable ? undefined : -1} compact icon={Check} label={`${t('homepage.markRead')}: ${title}`} onClick={onRead} />}
    </footer>
  </div>;
}

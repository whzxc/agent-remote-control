import { memo, type ReactNode } from 'react';
import { t } from '../../../i18n';
import type { TrackedActivity } from '../../../state/activityModel';
import type { TaskRecord, TaskRuntime } from '../../../state/tasks';
import type { AgentActivitySession } from '../../../types';
import { dispatchState } from '../../../state/sourceDispatch';
import { EntityRow, StateBadge } from '../../ui';
import { DispatchSpec } from '../../composites/DispatchSpec';
import { plainMarkdown } from '../../ui/Markdown';
import { PhaseTile } from '../../activity';
import { statePresentation } from '../statePresentation';
import { ActivityBubbleContent } from './Content';
import { dispatchActivity, projectName, receiptState, taskIdentity } from './projection';

export function taskTime(value: string) {
  const date = new Date(value), pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
type Props = { selected?: boolean; disabled?: boolean; actions?: ReactNode } & (
  | { kind: 'activity'; agent: string; session: TrackedActivity; live: boolean; now: number; onOpen?: () => void }
  | { kind: 'receipt'; record: TaskRecord; runtime?: TaskRuntime; records: readonly TaskRecord[]; id: string; onOpen: () => void }
  | { kind: 'dispatch'; record: TaskRecord; runtime?: TaskRuntime; live?: AgentActivitySession; onOpen: (session: TrackedActivity) => void }
);
export const TaskRow = memo(function TaskRow(props: Props) {
  const { selected, disabled, actions } = props;
  if (props.kind === 'activity') {
    const { agent, session, live, now, onOpen } = props;
    return <EntityRow className={`agent-conversation-row animate-in fade-in-0 duration-150 motion-reduce:animate-none [[data-reduced-motion=true]_&]:animate-none rounded-xl border bg-muted p-3 ${session.interaction ? 'border-warning bg-warning-soft' : ''} [&.entity-row-actions]:flex-wrap [&.entity-row-actions]:border-0 [&.entity-row-actions]:bg-transparent [&.entity-row-actions]:p-0`} selected={selected} disabled={disabled} actions={actions}
      data-density="standard" data-external={session.source === 'transcript' || undefined} data-timeline-anchor
      data-activity-session={JSON.stringify([agent, session.id])}
      aria-label={`${session.title || t('timeline.title')} · ${t('timeline.open')}`} onClick={onOpen}>
      <ActivityBubbleContent agent={agent} session={session} now={now} density="standard" historical={!live} conversationRow />
    </EntityRow>;
  }
  const { record, runtime } = props;
  const identity = taskIdentity({ kind: 'receipt', record, runtime, live: props.kind === 'dispatch' ? props.live : undefined });
  if (props.kind === 'dispatch') {
    const state = dispatchState(record, runtime, props.live);
    const session = dispatchActivity(record, runtime, props.live);
    const phase = state === 'pending' ? 'interaction' : state === 'running' ? props.live?.phase ?? 'thinking' : 'idle';
    return <EntityRow className="source-dispatch-row gap-2 rounded-xl border bg-card p-2.5 text-foreground disabled:cursor-default disabled:opacity-100 [&.entity-row-actions]:flex-wrap [&.entity-row-actions]:border-0 [&.entity-row-actions]:p-0" selected={selected} actions={actions} disabled={disabled || !session} attention={state === 'pending'} data-state={state}
      onClick={() => { if (session) props.onOpen(session); }} chevron={!!session}>
      <PhaseTile phase={phase} completed={state === 'completed'} animated={false} />
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{identity.title}</strong><span className="source-dispatch-meta text-xs text-muted-foreground">{record.agent ?? 'Codex'} · <StateBadge variant="text" presentation={statePresentation('dispatch', state)} /></span>
        <DispatchSpec agent={record.agent || 'codex'} record={{ kind: 'task', value: record }} variant="inline" /></span>
    </EntityRow>;
  }
  const state = receiptState(record, runtime, props.records);
  return <EntityRow className="task-document @container grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-none border-0 border-b bg-transparent px-3 py-2.5 text-start hover:bg-accent [&.entity-row-actions]:flex [&.entity-row-actions]:flex-wrap [&.entity-row-actions]:border-0 [&.entity-row-actions]:p-0" data-task-id={props.id} selected={selected} disabled={disabled} actions={actions}
    aria-label={identity.title} aria-haspopup="dialog" onClick={props.onOpen}>
    <span className="task-document-heading flex min-w-0 flex-wrap items-center gap-1.5"><strong className="task-document-title truncate text-sm font-medium">{identity.title}</strong>
      <DispatchSpec agent={record.agent || 'codex'} record={{ kind: 'task', value: record }} /></span>
    <span className="task-document-meta flex min-w-0 flex-wrap items-center justify-end gap-2 [&>time]:shrink-0 [&>time]:text-right [&>time]:text-xs [&>time]:text-muted-foreground [&>time]:tabular-nums">
      {projectName(identity.project) && <span className="task-tag inline-block max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground data-[tone=source]:bg-role-source-soft data-[tone=source]:text-role-source data-[tone=agent]:bg-role-agent-soft data-[tone=agent]:text-role-agent task-document-project max-w-44 truncate text-xs text-muted-foreground" title={identity.project}>{projectName(identity.project)}</span>}
      {state === 'running' && <StateBadge variant="text" presentation={statePresentation('dispatch', 'running')} label={t('running')} />}
      <time dateTime={record.createdAt}>{taskTime(record.createdAt)}</time>
    </span>
    {record.task.prompt && <span className="task-document-preview col-span-full row-start-2 block truncate text-xs text-muted-foreground">{plainMarkdown(record.task.prompt)}</span>}
  </EntityRow>;
});

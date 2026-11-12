import { Frame, Icon } from 'adg';
import { activitySamples, activityCopy as copy } from '../fixtures/task-activity';

export type TaskStepKind = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting';
export type TaskStep = { kind: TaskStepKind; text: string; status: 'completed' | 'running' | 'pending'; elapsed?: string };
export type TaskPlan = { completed: number; total: number; current: string };
export type TaskChange = { kind: 'file' | 'diff' | 'command'; summary: string; added?: number; removed?: number; output?: string };
const icons: Record<TaskStepKind, string> = {
  reading: 'file-search', editing: 'file-pen-line', command: 'terminal', thinking: 'brain', waiting: 'clock-3',
};
export function TaskActivityIcon({ kind, size = 14 }: { kind: TaskStepKind; size?: number }) {
  return <Icon name={icons[kind]} size={size} />;
}
export function TaskLiveTimeline({ steps, limit }: { steps: readonly TaskStep[]; limit: number }) {
  return <ol class="flex w-full min-w-0 flex-col gap-2" aria-label={copy.recent}>
    {steps.slice(-limit).map(step => <li class="flex min-w-0 items-center gap-2 text-meta leading-5">
      <span class={step.status === 'running' ? 'text-role-agent' : 'text-text-tertiary'}>
        <TaskActivityIcon kind={step.kind} />
      </span>
      <span class={`min-w-0 flex-1 truncate ${step.status === 'running' ? 'text-text font-semibold' : 'text-text-secondary'}`}
        title={step.text}>{step.text}</span>
      <span class="shrink-0 font-mono text-caption text-text-tertiary">{step.elapsed}</span>
    </li>)}
  </ol>;
}
export function TaskPlanProgress({ plan }: { plan: TaskPlan }) {
  return <div class="flex w-full flex-col gap-2">
    <div class="flex min-w-0 items-center gap-2 text-meta text-text-secondary">
      <Icon name="list-checks" size={14} />
      <span class="shrink-0 tabular-nums">{copy.plan} {plan.completed}/{plan.total}</span>
      <span class="min-w-0 truncate text-text" title={plan.current}>{plan.current}</span>
    </div>
    <div role="progressbar" aria-label={copy.plan} aria-valuenow={plan.completed} aria-valuemin={0} aria-valuemax={plan.total}
      class="h-1 overflow-hidden rounded-full bg-surface-sunken">
      <div class="h-full rounded-full bg-role-agent" style={{ width: `${plan.completed / plan.total * 100}%` }} />
    </div>
  </div>;
}
export function TaskChangeSummary({ change, compact = false }: { change: TaskChange; compact?: boolean }) {
  return <div class={`flex w-full min-w-0 flex-col gap-1 ${compact ? '' : 'rounded-field bg-surface-subtle p-3'}`}>
    <div class="flex min-w-0 items-center gap-2 text-meta leading-5">
      <Icon name={change.kind === 'command' ? 'terminal' : change.kind === 'diff' ? 'git-compare-arrows' : 'file-text'}
        size={14} class="shrink-0 text-text-secondary" />
      <code class="min-w-0 flex-1 truncate text-text" title={change.summary}>{change.summary}</code>
      {change.added !== undefined && <span class="shrink-0 font-mono text-success">+{change.added}</span>}
      {change.removed !== undefined && <span class="shrink-0 font-mono text-danger">−{change.removed}</span>}
    </div>
    {!compact && change.output && <p class="truncate text-meta leading-5 text-text-secondary" title={change.output}>{change.output}</p>}
  </div>;
}
export default () => [
  <Frame name="task-live-timeline-wide" width={440}><TaskLiveTimeline steps={activitySamples.steps} limit={5} /></Frame>,
  <Frame name="task-live-timeline-standard" width={440}><TaskLiveTimeline steps={activitySamples.steps} limit={3} /></Frame>,
  <Frame name="task-plan-progress" width={440}><TaskPlanProgress plan={activitySamples.plan} /></Frame>,
  <Frame name="task-change-summary" width={440}><TaskChangeSummary change={activitySamples.change} /></Frame>,
];

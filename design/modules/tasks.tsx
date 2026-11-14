import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from "../components/brand-mark";
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { ProjectLabel } from '../components/project-path';
import { DispatchSpec } from './model-configuration';
import type { TaskStep, TaskPlan, TaskChange } from './task-activity';
import {
  tasks, origins, snapshotForms, tasksCopy as copy, taskStatuses,
} from '../fixtures/tasks';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'recent' | 'unconfirmed';
export type TaskSnapshotData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
  project?: Parameters<typeof ProjectLabel>[0];
  change?: TaskChange; partial?: boolean; prompt?: string;
  snapshot?: readonly TaskStep[]; dispatch?: Parameters<typeof DispatchSpec>[0];
};

export function OriginChain({ steps }: { steps: readonly OriginStep[] }) {
  return <span class="inline-flex items-center gap-1 text-text-secondary"
    role="img" aria-label={steps.map(s => s.label).join(' → ')}>
    {steps.map((step, i) => <span class="inline-flex items-center gap-1" title={step.label}>
      {i > 0 && <Icon name="chevron-right" size={10} />}
      <span class="flex size-5 items-center justify-center rounded-full bg-surface-sunken">
        {step.brand ? <BrandMark brand={step.brand} size={14} /> : <Icon name={step.icon!} size={14} />}
      </span>
    </span>)}
  </span>;
}

export function NodeTaskFilter({ label = copy.filter }: { label?: string }) {
  return <div class="inline-flex items-center gap-2 self-start rounded-full border border-accent-text/40
    bg-accent-text/10 pl-3 text-small font-semibold text-accent-text" aria-label={`Tasks for ${label}`}>
    <Icon name="list-filter" size={14} />{label}<IconButton icon="x" label={copy.clear} compact />
  </div>;
}
export function TasksEmpty() {
  return <div class="flex h-full w-full flex-col items-center justify-center gap-3 text-text-secondary">
    <Tile icon="inbox" tone="neutral" /><h2 class="text-title font-semibold">{copy.empty}</h2>
  </div>;
}
const statusOf = (task: TaskSnapshotData) => taskStatuses[task.id]?.status ?? task.state;
function TaskIdentityMark({ task }: { task: TaskSnapshotData }) {
  const agent = task.origin.at(-2), source = task.origin[0];
  return <span class="relative grid size-8 shrink-0 place-items-center rounded-field bg-surface-subtle">
      <BrandMark brand={agent?.brand} size={20} />
      {source && source !== agent && <span class="absolute right-0 bottom-0 grid size-4 place-items-center rounded-full bg-surface">
        {source.brand ? <BrandMark brand={source.brand} size={11} /> : <Icon name={source.icon!} size={11} />}
      </span>}
    </span>;
}
export function TaskHistorySummary({ task }: { task: TaskSnapshotData }) {
  return <div class="flex w-full min-w-0 items-start gap-3 rounded-card bg-surface p-3 shadow-md">
    <TaskIdentityMark task={task} />
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <strong class="truncate text-small leading-5 text-text">{task.title}</strong>
      <span class="flex min-w-0 items-center gap-[6px] text-caption text-text-secondary">
        <span class="shrink-0">{statusOf(task)}</span>
        {task.project && <span class="min-w-0 flex-1 overflow-hidden"><ProjectLabel {...task.project} /></span>}
        {task.group === 'unconfirmed' && <span class="truncate">{task.detail}</span>}
      </span>
      {(task.dispatch || task.elapsed) && <div class="flex min-w-0 items-center gap-2">
        {task.dispatch && <DispatchSpec {...task.dispatch} />}
        {task.elapsed && <time class="shrink-0 text-caption tabular-nums text-text-secondary">{task.elapsed}</time>}
      </div>}
    </div>
  </div>;
}

export function TaskStatusMark({ task }: { task: TaskSnapshotData }) {
  const icon = task.group === 'needs-me' ? 'hourglass' : task.group === 'unconfirmed' ? 'circle-help' : task.group === 'running' ? task.icon : undefined;
  return <span class="ml-auto flex max-w-full shrink-0 items-center gap-[6px] text-caption text-text-secondary">
    {icon && <Icon name={icon} size={12} class={task.group === 'needs-me' ? 'text-warning' : task.group === 'running' ? 'text-phase-command' : 'text-text-tertiary'} />}
    <span class="truncate font-semibold">{statusOf(task)}</span>
    {task.elapsed && task.group !== 'unconfirmed' && <time class="shrink-0 tabular-nums text-text-tertiary">{task.elapsed}</time>}
  </span>;
}

function SnapshotNote({ tone, label, text }: { tone: 'source' | 'request'; label?: string; text?: string }) {
  return <div class="shrink-0 overflow-hidden rounded-[10px] bg-surface p-2">
    {label && <span class="block text-caption font-semibold leading-4 text-text-secondary">{label}</span>}
    <p class={`text-caption leading-4 ${tone === 'source' ? 'text-text-secondary' : 'text-text'}`}>{text}</p>
  </div>;
}

/** Portrait snapshot of one task. It reports status faithfully and carries no request actions. */
export function TaskSnapshot({ task, height = 340, narrow = false }: {
  task: TaskSnapshotData; height?: number | string; narrow?: boolean;
}) {
  const waiting = task.group === 'needs-me', done = task.group === 'unread';
  const steps = (task.snapshot ?? task.steps ?? []).slice(narrow ? -3 : -10), route = taskStatuses[task.id];
  const categories = [
    ['editing', 'Edited', 'file'], ['reading', 'Read', 'file'], ['command', 'Ran', 'command'],
  ] as const;
  const work = categories.flatMap(([kind, verb, unit]) => {
    const count = steps.filter(step => step.kind === kind).length;
    return count ? [`${verb} ${count} ${unit}${count === 1 ? '' : 's'}`] : [];
  }).join(' · ');
  const inset = narrow ? 'px-3' : 'px-4';
  return <article aria-label={`${task.title} · ${statusOf(task)}`} style={{ height }} class="flex w-full min-w-0 flex-col
    overflow-hidden rounded-panel border border-border bg-surface">
    <header class={`flex flex-wrap items-center gap-x-2 gap-y-1 pt-[14px] ${inset}`}>
      <OriginChain steps={narrow ? task.origin.filter(step => step.brand) : task.origin} />
      <TaskStatusMark task={task} />
    </header>
    <button aria-label={`${copy.open}: ${task.title}`} class={`truncate pt-[10px] text-left text-body leading-5
      font-semibold text-text ${inset}`}>{task.title}</button>
    {(task.dispatch || task.project || task.path) && <div class={`mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${inset}`}>
      {task.dispatch && <DispatchSpec {...task.dispatch} />}
      {task.project && <ProjectLabel {...task.project} />}
      {task.path && <span class="truncate text-caption text-text-tertiary">{task.path}</span>}
    </div>}
    <div class={`relative flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden rounded-[16px]
      bg-surface-subtle ${narrow ? 'm-2 p-2' : 'm-3 p-3'}`} aria-hidden="true">
      {task.prompt && <SnapshotNote tone="source" text={task.prompt} />}
      {work && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="wrench" size={12} /><span class="min-w-0 truncate">{work}</span>
      </div>}
      {steps.some(step => step.kind === 'thinking') && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="brain" size={12} /><span class="min-w-0 truncate">{steps.findLast(step => step.kind === 'thinking')?.text}</span>
      </div>}
      {waiting && <SnapshotNote tone="request" label={`Request → ${route?.route ?? ''}`} text={task.detail} />}
      {done && <p class="text-caption leading-4 text-text">{task.change?.output ?? task.activity}</p>}
    </div>
  </article>;
}

export function TaskGrid({ items, height, narrow = false, summary = false }: {
  items: readonly TaskSnapshotData[]; height: number; narrow?: boolean; summary?: boolean;
}) {
  return <div role="list" class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,224px),1fr))] gap-4">
    {items.map(task => <div role="listitem" class="flex min-w-0 flex-col gap-2">
      {summary ? <TaskHistorySummary task={task} /> : <TaskSnapshot task={task} height={height} narrow={narrow} />}
    </div>)}
  </div>;
}

export default () => [
  ...Object.entries(origins).filter(([name]) => ['local', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
  ...['finished', 'offline'].map(id => <Frame name={`task-summary-${id}`} width={260}>
    <TaskHistorySummary task={tasks.find(task => task.id === id)!} />
  </Frame>),
  ...snapshotForms.map(({ name, id }) => <Frame name={`task-snapshot-${name}`} width={260}>
    <TaskSnapshot task={tasks.find(task => task.id === id)!} />
  </Frame>),
  <Frame name="task-snapshot-narrow" width={171}><TaskSnapshot task={tasks[2]} height={290} narrow /></Frame>,
];

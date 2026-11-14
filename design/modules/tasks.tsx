import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from '../components/agent-icon';
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { SingleChoice } from '../components/single-choice';
import { TaskBubble } from './task-presentation';
import type { TaskStep, TaskPlan, TaskChange } from './task-activity';
import {
  tasks, origins, snapshotForms, tasksCopy as copy, switcherCopy as sw, switcherStatus,
} from '../fixtures/tasks';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'recent' | 'unconfirmed';
export type TaskSnapshotData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
  change?: TaskChange; partial?: boolean; prompt?: string;
  snapshot?: readonly TaskStep[];
};
export type TaskLayout = 'tile' | 'stack';

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
const statusMark: Record<TaskGroup, { icon: string; tone: 'agent' | 'warning' | 'success' | 'neutral' }> = {
  'needs-me': { icon: 'hourglass', tone: 'warning' }, running: { icon: 'loader-circle', tone: 'agent' },
  unread: { icon: 'check', tone: 'success' }, recent: { icon: 'check', tone: 'success' },
  unconfirmed: { icon: 'circle-help', tone: 'neutral' },
};
const statusOf = (task: TaskSnapshotData) => switcherStatus[task.id]?.status ?? task.state;
export const summaryOnly = (task: TaskSnapshotData) => task.group === 'recent' || task.group === 'unconfirmed';

export function TaskHistorySummary({ task }: { task: TaskSnapshotData }) {
  const mark = statusMark[task.group];
  return <TaskBubble form="compact" fill source={false} title={task.title} phase={statusOf(task)}
    headline={task.detail} icon={mark.icon} tone={mark.tone} />;
}

/** The status slot above a snapshot, like an app icon above a switcher card. */
export function TaskStatusMark({ task, labelled = true }: { task: TaskSnapshotData; labelled?: boolean }) {
  const mark = statusMark[task.group];
  return <span class="flex h-6 min-w-0 items-center gap-2" aria-label={statusOf(task)}>
    <Tile icon={mark.icon} form="phase" tone={mark.tone} size={24} />
    {labelled && <span class="min-w-0 truncate text-meta leading-4 font-semibold text-text">
      {statusOf(task)}
      {task.elapsed && task.group !== 'unconfirmed' && <span class="font-normal text-text-tertiary"> · {task.elapsed}</span>}
    </span>}
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
  const steps = (task.snapshot ?? task.steps ?? []).slice(narrow ? -3 : -10), route = switcherStatus[task.id];
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
    <header class={`flex items-center gap-2 pt-[14px] ${inset}`}>
      <OriginChain steps={narrow ? task.origin.filter(step => step.brand) : task.origin} />
      {task.path && !narrow && <span class="ml-auto truncate text-caption text-text-tertiary">{task.path}</span>}
    </header>
    <button aria-label={`${copy.open}: ${task.title}`} class={`truncate pt-[10px] text-left text-body leading-5
      font-semibold text-text ${inset}`}>{task.title}</button>
    <div class={`relative flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden rounded-[16px]
      bg-surface-subtle ${narrow ? 'm-2 p-2' : 'm-3 p-3'}`} aria-hidden="true">
      {task.prompt && <SnapshotNote tone="source" text={task.prompt} />}
      {work && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="wrench" size={12} /><span class="min-w-0 truncate">{work}</span>
      </div>}
      {steps.some(step => step.kind === 'thinking') && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="brain" size={12} /><span class="min-w-0 truncate">{steps.findLast(step => step.kind === 'thinking')?.text}</span>
      </div>}
      {waiting && <SnapshotNote tone="request" label={`${sw.request} → ${route?.route ?? ''}`} text={task.detail} />}
      {done && <p class="text-caption leading-4 text-text">{task.change?.output ?? task.activity}</p>}
    </div>
  </article>;
}

/** Tile/Stack layout choice at the right end of the homepage bar. */
export function TaskViewControls({ layout }: { layout: TaskLayout }) {
  return <div class="flex items-center gap-2">
    <SingleChoice label={sw.layout} value={layout} iconOnly compact class="w-[70px]" options={[
      { value: 'tile', label: sw.tile, icon: 'layout-grid' },
      { value: 'stack', label: sw.stack, icon: 'gallery-horizontal-end' },
    ]} />
  </div>;
}

/** Tile: full task previews above metadata-only history. */
export function TaskTiles({ items = tasks, columns, height, narrow = false }: {
  items?: readonly TaskSnapshotData[]; columns: 2 | 5 | 6; height: number; narrow?: boolean;
}) {
  const grid = { 2: 'grid-cols-2', 5: 'grid-cols-5', 6: 'grid-cols-6' }[columns];
  return <div role="list" aria-label={copy.tasks} class={`grid ${grid} ${narrow ? 'gap-x-3 gap-y-5' : 'gap-x-4 gap-y-6'}`}>
    {items.map(task => <div role="listitem" class="flex min-w-0 flex-col gap-2">
      {summaryOnly(task) ? <TaskHistorySummary task={task} /> : <>
        <TaskStatusMark task={task} />
        <div class="rounded-panel shadow-md"><TaskSnapshot task={task} height={height} narrow={narrow} /></div>
      </>}
    </div>)}
  </div>;
}

// Visible strip of each card behind the front one; spacing compresses with depth like a perspective deck.
const decks = {
  landscape: { width: 1280, card: 360, peeks: [132, 104, 82, 64, 50, 40, 32] },
  portrait: { width: 640, card: 340, peeks: [70, 52, 40, 30, 24, 18, 14] },
  mobile: { width: 390, card: 290, peeks: [34, 24, 16, 10, 8, 6, 4] },
} as const;
/** Stack: depth deck. The front card is whole; cards behind recede left, scaled, fogged and shadowed. */
export function TaskStack({ items = tasks, form = 'landscape', active = 0, spread = 0 }: {
  items?: readonly TaskSnapshotData[]; form?: keyof typeof decks; active?: number; spread?: number;
}) {
  const deck = decks[form], order = items.slice(0, deck.peeks.length + 1);
  const flat = Math.max(0, spread - active);
  const offsets = order.map((_, index) => {
    const depth = index - active;
    return Math.min(depth, flat) * (deck.card + 16)
      + deck.peeks.slice(0, Math.max(0, depth - flat)).reduce((sum, peek) => sum + peek, 0);
  });
  const span = deck.card + (offsets.at(-1) ?? 0);
  const minimumSpan = deck.card + flat * (deck.card + 16) + (flat && order.length > spread + 1 ? deck.peeks[0] : 0);
  const front = Math.min(deck.width - deck.card - 16, Math.max(minimumSpan - deck.card + 16, (deck.width + span) / 2 - deck.card));
  return <div class="flex min-h-0 flex-1 flex-col pt-4">
    <div data-free role="list" aria-label={copy.tasks} class="relative isolate min-h-0 w-full flex-1 overflow-hidden">
      {order.map((task, index) => ({ task, index, depth: Math.max(0, index - active - flat) })).reverse().map(({ task, index, depth }) => {
        const strip = depth > 0 ? deck.peeks[depth - 1] : deck.card;
        return <div role="listitem" aria-current={index === active ? 'true' : undefined}
          class={`absolute flex flex-col gap-3 ${summaryOnly(task) ? 'top-9' : 'inset-y-0'}`}
          style={{ left: front - offsets[index], width: deck.card, transform: `scale(${1 - Math.max(0, depth) * 0.035})`,
            transformOrigin: 'left center' }}>
          {summaryOnly(task) ? <TaskHistorySummary task={task} /> : <><div class="overflow-hidden" style={{ maxWidth: strip - 4 }}>
            <TaskStatusMark task={task} labelled={strip >= 100} />
          </div>
          <div class="relative min-h-0 flex-1 rounded-panel"
            style={{ boxShadow: '-18px 0 36px rgb(0 0 0 / 0.22), -3px 0 10px rgb(0 0 0 / 0.12)' }}>
            {index >= Math.max(0, active - 1) && index < Math.max(0, active - 1) + 5 ? <TaskSnapshot task={task} height="100%" /> : <div class="flex h-full flex-col gap-3 overflow-hidden rounded-panel border border-border bg-surface px-4 py-6" aria-hidden="true">
              <div class="h-3 w-2/3 rounded-field bg-surface-sunken blur-[3px]" /><div class="h-3 w-2/5 rounded-field bg-surface-sunken blur-[3px]" />
              <div class="mt-4 min-h-0 flex-1 rounded-field bg-surface-sunken blur-[3px]" />
            </div>}
            {depth > 0 && <span class="pointer-events-none absolute inset-0 rounded-panel bg-canvas"
              style={{ opacity: Math.min(depth * 0.09, 0.5) }} />}
          </div></>}
        </div>;
      })}
    </div>

  </div>;
}

export default () => [
  <Frame name="task-stack-browsed" width={1280} height={800}><TaskStack active={2} /></Frame>,
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
  ...snapshotForms.map(({ name, id }) => <Frame name={`task-status-mark-${name}`} width={260}>
    <TaskStatusMark task={tasks.find(task => task.id === id)!} />
  </Frame>),
  <Frame name="task-view-controls"><TaskViewControls layout="stack" /></Frame>,
];

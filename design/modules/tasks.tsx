import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from '../components/agent-icon';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { IconButton } from '../components/icon-button';
import { Disclosure, Tag } from '../components/tag';
import { Tile } from '../components/tile';
import { SingleChoice } from '../components/single-choice';
import {
  TaskLiveTimeline, TaskPlanProgress, TaskChangeSummary, TaskActivityIcon, type TaskStep, type TaskPlan, type TaskChange,
} from './task-activity';
import {
  tasks, origins, groups, cardForms, snapshotForms, tasksCopy as copy, switcherCopy as sw,
} from '../fixtures/tasks';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'unconfirmed';
export type TaskDensity = 'wide' | 'standard' | 'compact';
export type TaskCardData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
  change?: TaskChange; action?: 'answer' | 'approve'; partial?: boolean; prompt?: string;
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

export function TaskCard({ task, density = 'wide', expanded = false }: {
  task: TaskCardData; density?: TaskDensity; expanded?: boolean;
}) {
  const attention = task.group === 'needs-me', unread = task.group === 'unread', offline = task.group === 'unconfirmed';
  const compact = density === 'compact', details = !compact || expanded;
  const tone = attention ? 'warning' : unread ? 'success' : offline ? 'neutral' : 'command';
  return <article aria-label={task.title} class="min-w-0 w-full">
    <Card padded variant="reply" class={`h-full gap-3! border ${attention ? 'border-warning/45' : 'border-border'}`}>
      <header class="flex items-start gap-3">
        <Tile icon={task.icon} form="phase" tone={tone} />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <button aria-label={`${copy.open}: ${task.title}`} class="text-left text-body leading-5 font-semibold text-text"
            aria-keyshortcuts={attention || task.group === 'running' ? 'ArrowUp ArrowDown' : undefined}>
            {task.title}
          </button>
          <div class="flex flex-wrap items-center gap-2 text-meta leading-5 text-text-secondary">
            <span class={attention ? 'font-semibold text-warning' : unread ? 'text-success' : ''}>{task.state}</span>
            {!offline && task.elapsed && <span class="inline-flex items-center gap-1 font-mono text-caption">
              <Icon name="timer" size={12} />{task.elapsed}
            </span>}
          </div>
        </div>
        <IconButton icon="ellipsis" label={`${copy.more}: ${task.title}`} compact />
      </header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <OriginChain steps={task.origin} />
        {task.path && !offline && <Tag form="meta" icon={task.path.startsWith('LAN') ? 'wifi' : 'globe'}>{task.path}</Tag>}
        {offline && <span class="text-meta text-text-secondary">{task.detail}</span>}
      </div>
      {!offline && <p class={`text-small leading-5 text-text ${compact && !expanded ? 'truncate' : ''}`} title={task.activity}>
        {task.activity ?? task.detail}
      </p>}
      {details && !offline && <>
        {task.steps && <TaskLiveTimeline steps={task.steps} limit={density === 'wide' ? 5 : expanded ? 4 : 3} />}
        {task.plan && <TaskPlanProgress plan={task.plan} />}
      </>}
      {task.change && <TaskChangeSummary change={task.change} compact={!details} />}
      {task.partial && <span class="inline-flex items-center gap-1 text-meta text-text-secondary"><Icon name="history" size={12} /> {copy.partial}</span>}
      <footer class="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {task.action && <Button variant="primary" icon={task.action === 'answer' ? 'message-circle' : 'shield-question'}>
          {task.action === 'answer' ? copy.answer : copy.approve}
        </Button>}
        {compact && !offline && <button aria-expanded={expanded}
          class="inline-flex h-[30px] items-center gap-1 rounded-control px-2 text-small text-text-secondary">
          {expanded ? copy.hideActivity : copy.activity}<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>}
        <Button icon="arrow-up-right">{copy.open}</Button>
        {unread && <span class="ml-auto"><IconButton icon="check" label={`${copy.markRead}: ${task.title}`} compact /></span>}
      </footer>
    </Card>
  </article>;
}

export function NodeTaskFilter({ label = copy.filter }: { label?: string }) {
  return <div class="inline-flex items-center gap-2 self-start rounded-full border border-accent-text/40
    bg-accent-text/10 pl-3 text-small font-semibold text-accent-text" aria-label={`Tasks for ${label}`}>
    <Icon name="list-filter" size={14} />{label}<IconButton icon="x" label={copy.clear} compact />
  </div>;
}
export function TaskOverflow() {
  return <div class="inline-flex w-[180px] flex-col items-end gap-1">
    <IconButton icon="ellipsis" label={copy.more} active compact />
    <Card class="p-2! gap-1! shadow-md">
      <Button icon="arrow-up" variant="ghost">{copy.moveUp}</Button>
      <Button icon="arrow-down" variant="ghost">{copy.moveDown}</Button>
      <Button icon="arrow-up-right" variant="ghost">{copy.open}</Button>
    </Card>
  </div>;
}
export function TasksList({ items = tasks, columns = 2, density = 'standard', focused = false, expandedId, filterLabel }: {
  items?: readonly TaskCardData[]; columns?: 1 | 2 | 3; density?: TaskDensity; focused?: boolean;
  expandedId?: string; filterLabel?: string;
}) {
  return <div class="flex w-full flex-col gap-5">
    {focused && <NodeTaskFilter label={filterLabel} />}
    {groups.map(group => {
      const members = items.filter(t => t.group === group.id);
      const layout = columns === 1 ? 'flex flex-col' : columns === 3 && members.length >= 3 ? 'grid grid-cols-3' : 'grid grid-cols-2';
      return members.length > 0 && <section class="flex flex-col gap-3" aria-label={group.title}>
        <h2 class={`flex items-center gap-2 text-body leading-5 font-semibold ${group.paint}`}>
          {group.title}<span class="text-meta tabular-nums text-text-tertiary">{members.length}</span>
        </h2>
        <div class={`${layout} items-stretch gap-4`}>
          {members.map(task => <TaskCard task={task} density={density} expanded={task.id === expandedId} />)}
        </div>
      </section>;
    })}
    {items.length > 0 && !focused && <button aria-expanded="false" class="self-start">
      <Disclosure>{copy.recent}</Disclosure>
    </button>}
  </div>;
}
export function TasksEmpty() {
  return <div class="flex h-full w-full flex-col items-center justify-center gap-3 text-text-secondary">
    <Tile icon="inbox" tone="neutral" /><h2 class="text-title font-semibold">{copy.empty}</h2>
  </div>;
}
const groupPaint: Record<TaskGroup, string> = {
  'needs-me': 'text-warning', running: 'text-role-agent', unread: 'text-success', unconfirmed: 'text-text-tertiary',
};
function SnapshotNote({ tone, label, text }: { tone: 'source' | 'agent' | 'warning'; label?: string; text?: string }) {
  const paint = { source: 'bg-role-source', agent: 'bg-role-agent', warning: 'bg-warning' }[tone];
  return <div class="relative shrink-0 overflow-hidden rounded-[10px] bg-surface py-2 pl-[11px] pr-2">
    <span class={`absolute inset-y-0 left-0 w-[3px] ${paint}`} />
    {label && <span class={`block text-caption font-semibold leading-4 ${tone === 'warning' ? 'text-warning'
      : 'text-role-agent'}`}>{label}</span>}
    <p class={`line-clamp-2 text-caption leading-4 ${tone === 'source' ? 'text-text-secondary' : 'text-text'}`}>{text}</p>
  </div>;
}

/** Portrait snapshot of one task: route, state and a miniature of its latest timeline. */
export function TaskSnapshot({ task, height = 340, narrow = false }: {
  task: TaskCardData; height?: number; narrow?: boolean;
}) {
  const attention = task.group === 'needs-me', offline = task.group === 'unconfirmed', done = task.group === 'unread';
  const steps = (task.steps ?? task.snapshot ?? []).slice(narrow ? -3 : -5);
  return <article aria-label={task.title} style={{ height }} class={`flex w-full min-w-0 flex-col overflow-hidden
    rounded-panel border bg-surface shadow-md ${attention ? 'border-warning/55' : 'border-border'}`}>
    <header class={`flex items-center gap-2 pt-[14px] ${narrow ? 'px-3' : 'px-4'}`}>
      <OriginChain steps={narrow ? task.origin.filter(step => step.brand) : task.origin} />
      {task.elapsed && !offline && <span class="ml-auto inline-flex items-center gap-1 font-mono text-caption
        text-text-tertiary"><Icon name="timer" size={12} />{task.elapsed}</span>}
    </header>
    <div class={`flex flex-col gap-1 pt-[10px] ${narrow ? 'px-3' : 'px-4'}`}>
      <button aria-label={`${copy.open}: ${task.title}`} class="line-clamp-2 text-left text-body leading-5 font-semibold text-text">
        {task.title}
      </button>
      <span class={`flex min-w-0 items-center gap-[6px] text-meta leading-4 ${groupPaint[task.group]}`}>
        <span class="size-[6px] shrink-0 rounded-full bg-current" />
        <span class="truncate font-semibold">{task.state}</span>
        {task.path && !narrow && <span class="truncate text-text-tertiary">· {task.path}</span>}
      </span>
    </div>
    <div class={`relative mt-3 flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden rounded-[16px]
      bg-surface-subtle ${narrow ? 'mx-2 p-2' : 'mx-3 p-3'} ${offline ? 'opacity-60' : ''}`} aria-hidden="true">
      {task.prompt && <SnapshotNote tone="source" text={task.prompt} />}
      {steps.length > 0 && <ol class="flex shrink-0 flex-col gap-[6px]">
        {steps.map(step => <li class={`flex min-w-0 items-center gap-2 text-caption leading-4
          ${step.status === 'running' ? 'text-role-agent' : 'text-text-tertiary'}`}>
          <TaskActivityIcon kind={step.kind} size={12} />
          <span class={`min-w-0 flex-1 truncate ${step.status === 'running' ? 'font-semibold text-text'
            : 'text-text-secondary'}`}>{step.text}</span>
          {step.elapsed && <span class="shrink-0 font-mono">{step.elapsed}</span>}
        </li>)}
      </ol>}
      {attention && <SnapshotNote tone="warning" label={sw.request} text={task.detail} />}
      {done && <SnapshotNote tone="agent" label={sw.reply} text={task.change?.output ?? task.activity} />}
      {offline && <p class="shrink-0 text-caption leading-4 text-text-tertiary">{sw.lastSeen} · {task.detail}</p>}
      <div class="pointer-events-none absolute inset-x-0 top-0 h-8 bg-linear-to-b from-surface-subtle to-transparent" />
    </div>
    <footer class={`flex h-[58px] shrink-0 items-center gap-2 ${narrow ? 'px-3' : 'px-4'}`}>
      {task.action ? <Button variant="primary" class="w-full" icon={task.action === 'answer' ? 'message-circle'
        : 'shield-question'}>{task.action === 'answer' ? narrow ? sw.answer : copy.answer
        : narrow ? sw.review : copy.approve}</Button>
        : offline ? <span class="truncate text-meta text-text-secondary">{task.origin[1]?.label}</span>
        : task.plan && !narrow ? <TaskPlanProgress plan={task.plan} />
        : task.change ? <TaskChangeSummary change={task.change} compact /> : null}
      {done && <IconButton icon="check" label={`${copy.markRead}: ${task.title}`} compact />}
    </footer>
  </article>;
}

/** Filter and layout controls shared by Tile and Stack. */
export function TaskLayoutBar({ layout, filter = 'all', compact = false }: {
  layout: TaskLayout; filter?: string; compact?: boolean;
}) {
  return <div class="flex w-full items-center justify-between gap-3">
    <SingleChoice label={sw.filter} value={filter} dropdown={compact} options={[
      { value: 'all', label: `${sw.all} ${tasks.length}` },
      ...groups.map(group => ({ value: group.id, label: `${group.title} ${tasks.filter(t => t.group === group.id).length}` })),
    ]} />
    <SingleChoice label={sw.layout} value={layout} iconOnly options={[
      { value: 'tile', label: sw.tile, icon: 'layout-grid' },
      { value: 'stack', label: sw.stack, icon: 'gallery-horizontal-end' },
    ]} />
  </div>;
}

/** Tile: every task as a portrait snapshot in attention order. */
export function TaskTiles({ items = tasks, columns, height, narrow = false }: {
  items?: readonly TaskCardData[]; columns: 2 | 5 | 6; height: number; narrow?: boolean;
}) {
  const grid = { 2: 'grid-cols-2', 5: 'grid-cols-5', 6: 'grid-cols-6' }[columns];
  return <div role="list" aria-label={copy.tasks} class={`grid ${grid} ${narrow ? 'gap-3' : 'gap-4'}`}>
    {items.map(task => <div role="listitem"><TaskSnapshot task={task} height={height} narrow={narrow} /></div>)}
  </div>;
}

const stackForms = {
  landscape: { card: 300, height: 420, overlap: '-ml-[184px]', label: 'max-w-[108px]', align: 'justify-center' },
  portrait: { card: 300, height: 450, overlap: '-ml-[256px]', label: '', align: 'justify-end' },
  mobile: { card: 264, height: 420, overlap: '-ml-[232px]', label: '', align: 'justify-end' },
} as const;
/** Stack: one-sided deck. The first task in attention order is the front card; earlier cards show their leading strip. */
export function TaskStack({ items = tasks, form = 'landscape' }: {
  items?: readonly TaskCardData[]; form?: keyof typeof stackForms;
}) {
  const deck = [...items].reverse(), layout = stackForms[form];
  return <div class="my-auto flex w-full flex-col gap-4">
    <div role="list" aria-label={copy.tasks} class={`flex w-full overflow-hidden ${layout.align}`}>
      {deck.map((task, i) => {
        const front = i === deck.length - 1;
        return <div role="listitem" aria-current={front ? 'true' : undefined}
          class={`flex shrink-0 flex-col gap-2 ${i ? layout.overlap : ''}`} style={{ width: layout.card }}>
          <span class={`flex h-[22px] min-w-0 items-center gap-[6px] text-meta font-semibold ${groupPaint[task.group]}
            ${front ? '' : layout.label}`}>
            {(front || layout.label) && <><span class="size-[6px] shrink-0 rounded-full bg-current" />
              <span class="truncate">{task.state}</span></>}
          </span>
          <div class="rounded-panel shadow-lg"><TaskSnapshot task={task} height={layout.height} /></div>
        </div>;
      })}
    </div>
    {form === 'landscape' && <div class="flex items-center justify-center gap-2 text-meta text-text-tertiary">
      {['←', '→'].map(key => <kbd class="grid h-5 min-w-5 place-items-center rounded-[6px] bg-surface-sunken px-1
        font-sans text-caption text-text-secondary">{key}</kbd>)}
      <span class="mr-2">{sw.browse}</span>
      <kbd class="grid h-5 place-items-center rounded-[6px] bg-surface-sunken px-[6px] font-sans text-caption
        text-text-secondary">Enter</kbd>
      <span>{sw.open}</span>
    </div>}
  </div>;
}

export default () => [
  ...cardForms.map(({ name, id, width, density, ...props }) => <Frame name={`task-card-${name}`} width={width}>
    <TaskCard task={tasks.find(task => task.id === id)!} density={density} {...props} />
  </Frame>),
  ...Object.entries(origins).filter(([name]) => ['local', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="task-overflow"><TaskOverflow /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
  ...snapshotForms.map(({ name, id }) => <Frame name={`task-snapshot-${name}`} width={260}>
    <TaskSnapshot task={tasks.find(task => task.id === id)!} />
  </Frame>),
  <Frame name="task-snapshot-narrow" width={171}><TaskSnapshot task={tasks[2]} height={290} narrow /></Frame>,
  <Frame name="task-layout-bar" width={760}><TaskLayoutBar layout="tile" /></Frame>,
  <Frame name="task-layout-bar-compact" width={358}><TaskLayoutBar layout="stack" compact /></Frame>,
];

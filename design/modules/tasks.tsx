import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from '../components/agent-icon';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { IconButton } from '../components/icon-button';
import { Disclosure, Tag } from '../components/tag';
import { Tile } from '../components/tile';
import { TaskLiveTimeline, TaskPlanProgress, TaskChangeSummary, type TaskStep, type TaskPlan, type TaskChange } from './task-activity';
import { tasks, origins, groups, cardForms, tasksCopy as copy } from '../fixtures/tasks';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'unconfirmed';
export type TaskDensity = 'wide' | 'standard' | 'compact';
export type TaskCardData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
  change?: TaskChange; action?: 'answer' | 'approve'; partial?: boolean;
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
export default () => [
  ...cardForms.map(({ name, id, width, density, ...props }) => <Frame name={`task-card-${name}`} width={width}>
    <TaskCard task={tasks.find(task => task.id === id)!} density={density} {...props} />
  </Frame>),
  ...Object.entries(origins).filter(([name]) => ['local', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="task-overflow"><TaskOverflow /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
];

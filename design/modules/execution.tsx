import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from '../components/agent-icon';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { IconButton } from '../components/icon-button';
import { Disclosure } from '../components/tag';
import { Tile } from '../components/tile';
import { TaskRow } from './task-presentation';
import { tasks, origins, groups, executionCopy as copy } from '../fixtures/execution';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type ExecutionGroup = 'needs-me' | 'running' | 'unread' | 'unconfirmed';
export type ExecutionTask = {
  id: string; node: string; title: string; group: ExecutionGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
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

export function ExecutionTaskCard({ task }: { task: ExecutionTask }) {
  const attention = task.group === 'needs-me', unread = task.group === 'unread';
  const tone = attention ? 'warning' : unread ? 'success' : task.group === 'unconfirmed' ? 'neutral' : 'command';
  return <article aria-label={task.title} class="min-w-0">
    <TaskRow title={task.title} attention={attention} tile={<Tile icon={task.icon} form="phase" tone={tone} />}
      trailing={<div class="flex items-start gap-1">
        {unread && <IconButton icon="check" label={`${copy.markRead}: ${task.title}`} compact />}
        <IconButton icon="ellipsis" label={`${copy.more}: ${task.title}`} compact />
      </div>}>
      <button aria-label={`${copy.open}: ${task.title}`} class="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
        aria-keyshortcuts={attention || task.group === 'running' ? 'ArrowUp ArrowDown' : undefined}>
        <strong class="block w-full truncate text-small leading-4 font-semibold text-text" title={task.title}>{task.title}</strong>
        <span class="block w-full truncate text-meta leading-4 text-text-secondary">
          <span class={attention ? 'font-semibold text-warning' : unread ? 'text-success' : ''}>{task.state}</span>
          {' · '}{task.detail}
        </span>
        <OriginChain steps={task.origin} />
      </button>
    </TaskRow>
  </article>;
}

export function NodeTaskFilter() {
  return <div class="inline-flex items-center gap-2 self-start rounded-full border border-accent-text/40
    bg-accent-text/10 pl-3 text-small font-semibold text-accent-text" aria-label={copy.filtered}>
    <Icon name="laptop" size={14} />{copy.filter}<IconButton icon="x" label={copy.clear} compact />
  </div>;
}

export function ExecutionTaskOverflow() {
  return <div class="inline-flex w-[180px] flex-col items-end gap-1">
    <IconButton icon="ellipsis" label={copy.more} active compact />
    <Card class="p-2! gap-1! shadow-md">
      <Button icon="arrow-up" variant="ghost">{copy.moveUp}</Button>
      <Button icon="arrow-down" variant="ghost">{copy.moveDown}</Button>
      <Button icon="arrow-up-right" variant="ghost">{copy.open}</Button>
    </Card>
  </div>;
}

export function ExecutionList({ items = tasks, columns = 2, focused = false }: {
  items?: readonly ExecutionTask[]; columns?: 1 | 2; focused?: boolean;
}) {
  return <div class="mx-auto flex w-full max-w-[960px] flex-col gap-3">
    {focused && <NodeTaskFilter />}
    {groups.map(group => {
      const members = items.filter(t => t.group === group.id);
      return members.length > 0 && <section class="flex flex-col gap-2" aria-label={group.title}>
        <h2 class={`flex items-center gap-2 text-body leading-5 font-semibold ${group.paint}`}>
          {group.title}<span class="text-meta tabular-nums text-text-tertiary">{members.length}</span>
        </h2>
        <div class={columns === 2 ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-2'}>
          {members.map(task => <ExecutionTaskCard task={task} />)}
        </div>
      </section>;
    })}
    {items.length > 0 && !focused && <button aria-expanded="false" class="self-start">
      <Disclosure>{copy.recent}</Disclosure>
    </button>}
  </div>;
}

export function ExecutionEmpty() {
  return <div class="flex h-full w-full flex-col items-center justify-center gap-3 text-text-secondary">
    <Tile icon="inbox" tone="neutral" /><h2 class="text-title font-semibold">{copy.empty}</h2>
  </div>;
}

export default () => [
  ...tasks.map(task => <Frame name={`execution-task-card-${task.id}`} width={468}><ExecutionTaskCard task={task} /></Frame>),
  ...Object.entries(origins).filter(([name]) => ['local', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="execution-task-overflow"><ExecutionTaskOverflow /></Frame>,
  <Frame name="execution-empty" width={360} height={180}><ExecutionEmpty /></Frame>,
];

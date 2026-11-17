export function TaskFeedSection({ children }: { children: unknown }) { return <section class="text-small text-text-secondary">{children}</section>; }
export function TaskFilter({ children }: { children: unknown }) { return <div class="rounded-full border border-accent-text/40 bg-accent-text/10 text-small font-semibold text-accent-text">{children}</div>; }
import { Button } from "../components/button";
import { Panel } from "../components/panel";
import { examples, listOrigins, stateCopy, type ListExample, type ChildState } from "../fixtures/task-list";
import { aurora, OriginChain } from '../components/task-card';
import { Frame, Icon } from 'adg';
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { ProjectLabel } from '../components/project-path';
import { DispatchSpec } from '../components/dispatch-spec';
import { tasksCopy as copy } from '../fixtures/tasks';

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

export function TaskGrid({ items }: { items: readonly ListExample[] }) {
  return <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,242px),1fr))] gap-4">{items.map(task => <GroupedTaskCard task={task} />)}</div>;
}

export default () => [
  <Frame name="parent-with-subagents" width={260} locale="zh-CN">
    <div class="w-[260px]"><GroupedTaskCard task={examples[0]} /></div>
  </Frame>,
  <Frame name="empty-preview-actions" width={320} locale="zh-CN">
    <div class="flex h-32 w-full rounded-field bg-surface-subtle text-text"><EmptyTaskBody state="error" /></div>
  </Frame>,
  <Frame name="subagent-list" width={600} locale="zh-CN">
    <ChildTaskList task={examples[0]} />
  </Frame>,
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
];

const stateStyle = {
  'needs-input': { icon: 'circle-help', ink: 'text-warning' },
  complete: { icon: 'circle-check', ink: 'text-text-secondary' },
};

function ListState({ state }: { state: ChildState }) {
  if (state === 'running') return null;
  return <span class={`inline-flex shrink-0 items-center gap-1 text-caption ${stateStyle[state].ink}`}>
    <Icon name={stateStyle[state].icon} size={13} />{stateCopy[state]}
  </span>;
}

export function EmptyTaskBody({ state, detail = false }: { state: 'empty' | 'error' | 'loading'; detail?: boolean }) {
  const label = { empty: '暂无正文记录', error: '正文加载失败', loading: '正在加载正文' }[state];
  const action = state === 'error' ? '重试' : detail ? '重新加载' : '查看任务详情';
  return <div class="flex w-full flex-1 flex-col items-center justify-center gap-1 text-center">
    <span role="status" class="inline-flex items-center gap-1.5 text-small text-text-secondary">
      <Icon name={{ empty: 'message-square', error: 'circle-alert', loading: 'loader-circle' }[state]} size={14} />
      {label}
    </span>
    {state !== 'loading' && <Button variant="link" icon={state === 'empty' && !detail ? 'arrow-right' : 'rotate-ccw'}>{action}</Button>}
  </div>;
}

export function GroupedTaskCard({ task }: { task: ListExample }) {
  const chain = task.viaClaude ? listOrigins.claudeToCodex : listOrigins.codex;
  const emptyState = !task.excerpt && (task.preview === 'error' || task.preview === 'empty' || task.preview === 'loading') ? task.preview : undefined;
  const previewLabel = { reply: '最新回复', activity: '最近进展', loading: '正在加载正文', error: '正文加载失败', empty: '暂无正文记录' }[task.preview];
  const attention = task.children?.filter(child => child.state === 'needs-input').length;
  return <article aria-label={task.title} style={{ '--aurora-tint': 'var(--phase-thinking)' }}
    class={`flex h-[256px] min-w-0 flex-col rounded-card border bg-surface p-[14px] shadow-md ${task.status === 'running' ? aurora : 'border-border'}`}>
    <div class="flex items-center gap-1">
      <div class="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"><div class="flex w-max"><OriginChain steps={chain} /></div></div>
      <span class="shrink-0"><ListState state={task.status} /></span>
      <time class="shrink-0 text-caption tabular-nums text-text-tertiary">{task.time}</time>
    </div>
    <button class="mt-2 truncate text-left text-body font-semibold text-text">{task.title}</button>
    <div class="mt-2 flex h-6 items-center gap-[6px] overflow-hidden whitespace-nowrap">
      <DispatchSpec model={task.model} position={{ count: 4, index: 2 }} fast />
      <ProjectLabel name={task.project} /><span class="text-caption text-text-tertiary">{task.turns} 轮</span>
    </div>
    <div class="mt-3 flex min-h-0 flex-1 flex-col rounded-field bg-surface-subtle px-3 py-2">
      {emptyState ? <EmptyTaskBody state={emptyState} /> : <>
        <span class="inline-flex h-5 items-center gap-1.5 text-caption text-text-secondary">
          <Icon name={task.preview === 'reply' ? 'message-square' : task.preview === 'loading' ? 'loader-circle' : 'activity'} size={13} />
          {previewLabel}
        </span>
        {task.excerpt && <p class="mt-1 line-clamp-2 text-small leading-5 text-text">{task.preview === 'loading' && '任务要求 · '}{task.excerpt}</p>}
      </>}
    </div>
    {task.children && <button class="mt-2 flex h-6 shrink-0 items-center gap-2 text-small font-semibold text-text">
      <Icon name="git-fork" size={14} />{task.children.length} 个子任务
      {Boolean(attention) && <span class="ml-auto text-caption font-medium text-warning">{attention} 个待确认</span>}
      <Icon name="chevron-right" size={14} />
    </button>}
  </article>;
}

export function ChildTaskList({ task }: { task: ListExample }) {
  return <Panel size="m" title="子任务" viewportHeight={640}>
    <div class="mb-3 flex items-center gap-2 border-b border-border pb-4 text-small text-text-secondary">
      <Icon name="git-fork" size={15} /><span>{task.title}</span>
    </div>
    <div class="flex flex-col gap-2">
      {task.children?.map(child => <button style={{ '--aurora-tint': 'var(--phase-thinking)' }} class={`flex w-full items-center gap-3 rounded-card border px-3 py-2 text-left ${child.state === 'running' ? aurora : 'border-border bg-surface'}`}>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2"><span class="truncate text-body font-semibold text-text">{child.assignment}</span><ListState state={child.state} /></div>
          <div class="mt-1 flex items-baseline gap-2 text-caption text-text-secondary">
            <span class="truncate">{child.name} · {child.latest}</span>
          </div>
        </div><Icon name="chevron-right" size={14} />
      </button>)}
    </div>
  </Panel>;
}

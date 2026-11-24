export function TaskFeedSection({ children }: { children: unknown }) { return <section class="text-small text-text-secondary">{children}</section>; }
export function TaskFilter({ children }: { children: unknown }) { return <div class="rounded-full border border-accent-text/40 bg-accent-text/10 text-small font-semibold text-accent-text">{children}</div>; }
import { Button } from "../components/button";
import { Panel } from "../components/panel";
import { examples, listOrigins, type ListExample } from "../fixtures/task-list";
import { TaskCard, type TaskSnapshotData } from '../components/task-card';
import { Frame, Icon } from 'adg';
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { tasksCopy as copy } from '../fixtures/tasks';

const taskGrid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,242px),1fr))]';

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

function toTaskSnapshot(task: ListExample): TaskSnapshotData {
  const origin = task.originKey ? listOrigins[task.originKey] : task.viaClaude ? listOrigins.claudeToCodex : listOrigins.codex;
  return {
    id: task.title,
    node: task.originKey === 'antigravity' ? 'local-antigravity' : 'local-codex',
    title: task.title,
    group: task.status === 'running' ? 'running' : task.status === 'needs-input' ? 'needs-me' : 'recent',
    state: task.status,
    detail: task.excerpt ?? '',
    icon: task.preview === 'activity' ? 'terminal' : 'check',
    origin,
    elapsed: task.time,
    turns: task.turns,
    phase: task.status === 'running' ? 'thinking' : undefined,
    project: { name: task.project },
    dispatch: { model: task.model, effort: task.effort ?? 'High', position: { count: 4, index: 2 }, tier: task.tier ?? 'Fast', fast: true },
    previewLines: task.previewLines ?? (task.excerpt ? [{ kind: 'agent', text: task.excerpt }] : undefined),
  };
}

function SubtaskFooter({ count, attention }: { count: number; attention: number }) {
  return (
    <button class="mx-2 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-tile border border-border/70
      bg-surface-subtle/60 px-[10px] text-small font-semibold text-text">
      <Icon name="git-fork" size={14} class="text-text-secondary" />
      <span>{count} 个子任务</span>
      {Boolean(attention) && (
        <span class="ml-auto rounded-full border border-warning/25 bg-warning/10 px-[7px] py-[1px]
          text-caption font-semibold text-warning">
          {attention} 个待确认
        </span>
      )}
      <Icon name="chevron-right" size={14} class={attention ? 'text-text-secondary' : 'ml-auto text-text-secondary'} />
    </button>
  );
}

function gridTaskCard(task: ListExample, form: 'detail' | 'summary') {
  const detail = form === 'detail';
  const emptyState = !task.previewLines && !task.excerpt && (task.preview === 'error' || task.preview === 'empty' || task.preview === 'loading')
    ? task.preview
    : undefined;
  const attention = task.children?.filter(child => child.state === 'needs-input').length ?? 0;
  return <TaskCard
    task={toTaskSnapshot(task)}
    form={form}
    attention={attention > 0}
    class={detail ? 'min-h-[224px] h-full' : 'h-[106px]'}
    emptyBody={detail && emptyState ? <EmptyTaskBody state={emptyState} /> : undefined}
    footer={detail && task.children?.length ? <SubtaskFooter count={task.children.length} attention={attention} /> : undefined}
  />;
}

export function TaskGrid({ items, day }: {
  items: readonly ListExample[];
  day: { columns: number; form: 'detail' | 'summary'; expanded?: boolean };
}) {
  const limit = day.columns * 2;
  const split = items.length > limit ? limit - 1 : items.length;
  const overflow = items.length - split;
  const visible = day.expanded ? items : items.slice(0, split);
  return <div class={`${taskGrid} items-stretch gap-x-4 gap-y-6`}>
    {visible.map(task => gridTaskCard(task, day.form))}
    {overflow > 0 && <DayOverflowCard count={overflow} form={day.form} expanded={day.expanded} />}
  </div>;
}

function DayOverflowCard({ count, form, expanded = false }: { count: number; form: 'detail' | 'summary'; expanded?: boolean }) {
  return <button type="button" aria-expanded={expanded}
    class={`relative isolate flex w-full min-w-0 flex-col text-left focus-visible:outline-2 focus-visible:outline-accent ${expanded ? '' : 'pt-3'} ${form === 'detail' ? 'min-h-[224px] h-full' : 'h-[106px]'}`}>
    {!expanded && <>
      <span aria-hidden="true" class="absolute inset-x-3 inset-y-0 rounded-card border border-border-strong bg-surface-subtle" />
      <span aria-hidden="true" class="absolute inset-x-1.5 top-1.5 bottom-0 rounded-card border border-border-strong bg-surface-subtle" />
    </>}
    <span class={`relative flex w-full flex-1 items-center justify-between gap-2 rounded-card border px-[14px] shadow-md ${expanded ? 'border-border bg-surface-subtle' : 'border-border-strong bg-surface'}`}>
      <strong class="text-body font-semibold text-text">{expanded ? '收起' : '展开'} {count} 个任务</strong>
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} class="shrink-0 text-text-secondary" />
    </span>
  </button>;
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

export function ChildTaskList({ task }: { task: ListExample }) {
  return <Panel size="m" transparent title={task.title} viewportHeight={640}>
    <div class="flex flex-col gap-2">
      {task.children?.map(child => (
        <TaskCard form="summary" task={{
          id: child.name,
          node: 'local-codex',
          title: `${child.name} · ${child.assignment}`,
          group: child.state === 'needs-input' ? 'needs-me' : child.state === 'running' ? 'running' : 'recent',
          state: child.state,
          detail: child.latest,
          icon: child.state === 'running' ? 'terminal' : 'check',
          origin: listOrigins.codex,
          elapsed: child.elapsed,
          project: { name: task.project },
          dispatch: { model: task.model, effort: 'High', position: { count: 4, index: 2 } },
        }} />
      ))}
    </div>
  </Panel>;
}

export default () => [
  <Frame name="parent-with-subagents" width={280} locale="zh-CN">
    <div class="w-[280px]">{gridTaskCard(examples[0], 'detail')}</div>
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

export function TaskFeedSection({ children }: { children: unknown }) { return <section class="text-small text-text-secondary">{children}</section>; }
export function TaskFilter({ children }: { children: unknown }) { return <div class="rounded-full border border-accent-text/40 bg-accent-text/10 text-small font-semibold text-accent-text">{children}</div>; }
import { Button } from "../components/button";
import { BrandMark } from "../components/brand-mark";
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

function SubtaskPill({ count, attention }: { count: number; attention: number }) {
  return (
    <button
      type="button"
      aria-label={attention ? `${count} 个子任务 · ${attention} 个待确认` : `${count} 个子任务`}
      class={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-caption font-semibold tabular-nums ${
        attention
          ? 'border-warning/35 bg-warning/10 text-warning'
          : 'border-border-strong bg-surface text-text'
      }`}
    >
      <Icon name="git-fork" size={11} class={attention ? 'text-warning' : 'text-text-secondary'} />
      <span>{attention ? `${count} · ${attention}` : count}</span>
      <Icon name="chevron-right" size={11} class={attention ? 'text-warning' : 'text-text-tertiary'} />
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
    metaAction={detail && task.children?.length ? <SubtaskPill count={task.children.length} attention={attention} /> : undefined}
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
  const hiddenItems = items.slice(split);
  return <div class={`${taskGrid} items-stretch gap-x-4 gap-y-6`}>
    {visible.map(task => gridTaskCard(task, day.form))}
    {overflow > 0 && <DayOverflowCard count={overflow} total={items.length} hiddenItems={hiddenItems} form={day.form} expanded={day.expanded} />}
  </div>;
}

function DayOverflowCard({ count, total, hiddenItems, form, expanded = false }: {
  count: number; total: number; hiddenItems: readonly ListExample[]; form: 'detail' | 'summary'; expanded?: boolean;
}) {
  const peekLimit = form === 'detail' ? 4 : 2;
  const peek = hiddenItems.slice(0, peekLimit);
  const more = Math.max(0, count - peek.length);
  const label = `${expanded ? '收起' : '展开'} ${count} 个任务`;
  return <button type="button" aria-expanded={expanded} aria-label={label}
    class={`relative isolate flex w-full min-w-0 flex-col text-left focus-visible:outline-2 focus-visible:outline-accent ${expanded ? '' : 'pt-3'} ${form === 'detail' ? 'min-h-[224px] h-full' : 'h-[106px]'}`}>
    {!expanded && <>
      <span aria-hidden="true" class="absolute inset-x-3 inset-y-0 rounded-card border border-border-strong bg-surface-subtle" />
      <span aria-hidden="true" class="absolute inset-x-1.5 top-1.5 bottom-0 rounded-card border border-border-strong bg-surface-subtle" />
    </>}
    <span class={`relative flex w-full flex-1 flex-col gap-2 overflow-hidden rounded-card border p-3 shadow-md ${expanded ? 'justify-center border-border bg-surface-subtle' : 'justify-between border-border-strong bg-surface'}`}>
      <span class="flex items-center justify-between gap-2">
        <strong class="truncate text-body font-semibold text-text">{label}</strong>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} class="shrink-0 text-text-secondary" />
      </span>
      {!expanded && peek.length > 0 && (
        <span aria-hidden="true" class="flex min-h-0 flex-1 flex-col justify-between gap-1.5 rounded-tile bg-surface-subtle px-2.5 py-2">
          <span class="flex flex-col gap-1">
            {peek.map(item => {
              const brand = item.originKey === 'antigravity' ? 'antigravity' : item.viaClaude ? 'claude' : 'codex';
              return (
                <span class="flex items-center gap-1.5 text-caption leading-4 text-text-secondary">
                  <BrandMark brand={brand} size={12} />
                  <span class="min-w-0 flex-1 truncate">{item.title}</span>
                  <span class="shrink-0 tabular-nums text-text-tertiary">{item.time}</span>
                </span>
              );
            })}
          </span>
          {form === 'detail' && more > 0 && (
            <span class="text-caption leading-4 tabular-nums text-text-tertiary">还有 {more} 项</span>
          )}
        </span>
      )}
      {expanded && (
        <span aria-hidden="true" class="text-caption tabular-nums text-text-tertiary">共 {total} 个任务</span>
      )}
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

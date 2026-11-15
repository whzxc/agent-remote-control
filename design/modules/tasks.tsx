export function TaskFeedSection({ children }: { children: unknown }) { return <section class="text-small text-text-secondary">{children}</section>; }
export function TaskFilter({ children }: { children: unknown }) { return <div class="rounded-full border border-accent-text/40 bg-accent-text/10 text-small font-semibold text-accent-text">{children}</div>; }
import { TaskCard, type TaskSnapshotData } from '../components/task-card';
import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from "../components/brand-mark";
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { ProjectLabel } from '../components/project-path';
import { DispatchSpec } from '../components/dispatch-spec';
import type { TaskStep, TaskPlan, TaskChange } from '../modules/homepage-scene';
import { tasks, origins, snapshotForms, auroraForms, tasksCopy as copy, taskStatuses } from '../fixtures/tasks';

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

export function TaskGrid({ items, summary = false }: {
  items: readonly TaskSnapshotData[]; summary?: boolean;
}) {
  return <div role="list" class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,224px),1fr))] items-start gap-4">
    {items.map(task => <div role="listitem" class="flex min-w-0 flex-col gap-2">
      <TaskCard task={task} form={summary ? "summary" : "detail"} />
    </div>)}
  </div>;
}

export default () => [
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
];

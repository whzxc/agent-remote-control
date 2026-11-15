import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from "../components/brand-mark";
import { IconButton } from '../components/icon-button';
import { Tile } from '../components/tile';
import { ProjectLabel } from '../components/project-path';
import { DispatchSpec } from './model-configuration';
import type { TaskStep, TaskPlan, TaskChange } from './task-activity';
import {
  tasks, origins, snapshotForms, auroraForms, tasksCopy as copy, taskStatuses,
} from '../fixtures/tasks';

export type OriginStep = { label: string; brand?: Brand; icon?: string };
export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'recent' | 'unconfirmed';
export type TaskSnapshotData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; turns?: number; phase?: 'thinking' | 'command' | 'file' | 'tool' | 'text'; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
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
const scrollRow = 'min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const aurora = 'border-transparent [background:linear-gradient(var(--surface),var(--surface))_padding-box,conic-gradient(from_24deg,var(--border)_0deg,var(--border)_25deg,var(--aurora-tint)_75deg,var(--border)_142deg,var(--border)_215deg,var(--aurora-tint)_275deg,var(--border)_360deg)_border-box] [box-shadow:var(--shadow-md),0_0_15px_color-mix(in_srgb,var(--aurora-tint)_24%,transparent)]';

export function TaskCardHeader({ task, heading = false }: { task: TaskSnapshotData; heading?: boolean }) {
  const timing = task.group === 'unconfirmed' ? task.detail : task.elapsed;
  const title = 'w-max whitespace-nowrap text-left text-body leading-5 font-semibold text-text';
  return <header class="flex w-full min-w-0 flex-col gap-2 px-[14px] py-3">
    <div class="flex h-5 min-w-0 items-center justify-between gap-2">
      <div class={`flex-1 ${scrollRow}`}><div class="flex w-max"><OriginChain steps={task.origin} /></div></div>
      {timing && <time class="shrink-0 whitespace-nowrap text-caption tabular-nums text-text-tertiary">{timing}</time>}
    </div>
    <div class={scrollRow}>{heading ? <h2 class={title}>{task.title}</h2>
      : <button aria-label={`${copy.open}: ${task.title}`} class={title}>{task.title}</button>}</div>
    <div class={scrollRow}><div class="flex h-6 w-max items-center gap-[6px] whitespace-nowrap">
      {task.dispatch && <DispatchSpec {...task.dispatch} />}
      {task.project && <ProjectLabel {...task.project} />}
      {task.turns !== undefined && <span class="text-caption tabular-nums text-text-tertiary">{task.turns} {task.turns === 1 ? 'turn' : 'turns'}</span>}
    </div></div>
  </header>;
}

function SnapshotNote({ tone, label, text }: { tone: 'source' | 'request'; label?: string; text?: string }) {
  return <div class="shrink-0 overflow-hidden rounded-[10px] bg-surface p-2">
    {label && <span class="block text-caption font-semibold leading-4 text-text-secondary">{label}</span>}
    <p class={`text-caption leading-4 ${tone === 'source' ? 'text-text-secondary' : 'text-text'}`}>{text}</p>
  </div>;
}

/** Portrait snapshot of one task. It reports status faithfully and carries no request actions. */
export function TaskCard({ task, form }: {
  task: TaskSnapshotData; form: 'summary' | 'detail';
}) {
  const preview = form === 'detail';
  const phase = task.phase ?? (task.icon === 'brain' ? 'thinking' : task.icon === 'terminal' ? 'command' : undefined);
  const active = preview && task.group === 'running';
  const tint = phase ? `var(--phase-${phase})` : 'var(--role-agent)';
  const waiting = task.group === 'needs-me', done = task.group === 'unread';
  const steps = (task.snapshot ?? task.steps ?? []).slice(-10), route = taskStatuses[task.id];
  const categories = [
    ['editing', 'Edited', 'file'], ['reading', 'Read', 'file'], ['command', 'Ran', 'command'],
  ] as const;
  const work = categories.flatMap(([kind, verb, unit]) => {
    const count = steps.filter(step => step.kind === kind).length;
    return count ? [`${verb} ${count} ${unit}${count === 1 ? '' : 's'}`] : [];
  }).join(' · ');
  return <article aria-label={task.title} style={{ '--aurora-tint': active ? tint : undefined }}
    class={`flex w-full min-w-0 flex-col rounded-card border ${active ? aurora : 'border-border bg-surface shadow-md'}`}>
    <TaskCardHeader task={task} />
    {preview && <div class="mx-[10px] mb-[10px] flex min-h-10 max-h-[180px] flex-col justify-end gap-2 overflow-hidden rounded-field bg-surface-subtle px-3 py-[10px]" aria-hidden="true">
      {task.prompt && <SnapshotNote tone="source" text={task.prompt} />}
      {work && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="wrench" size={12} /><span class="min-w-0 truncate">{work}</span>
      </div>}
      {steps.some(step => step.kind === 'thinking') && <div class="flex items-center gap-[6px] text-caption text-text-secondary">
        <Icon name="brain" size={12} /><span class="min-w-0 truncate">{steps.findLast(step => step.kind === 'thinking')?.text}</span>
      </div>}
      {waiting && <SnapshotNote tone="request" label={`Request → ${route?.route ?? ''}`} text={task.detail} />}
      {(done || task.activity) && <p class="text-caption leading-4 text-text">{task.change?.output ?? task.activity}</p>}
    </div>}
  </article>;
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
  <Frame name="shared-task-card-forms" width={720}>
    <div class="grid w-full grid-cols-2 items-start gap-4 bg-canvas p-6">
      {(['summary', 'detail'] as const).map(form => <TaskCard task={tasks.find(task => task.id === 'finished')!} form={form} />)}
    </div>
  </Frame>,
  <Frame name="task-card-aurora" width={864}>
    <div class="grid w-full grid-cols-3 gap-4 bg-canvas p-6">
      {auroraForms.map(({ phase, name, activity }) => <section class="flex min-w-0 flex-col gap-2">
        <h2 class="text-small text-text-secondary">{name}</h2>
        <TaskCard task={{ ...tasks[2], phase, activity, snapshot: [], steps: [], prompt: undefined, change: undefined }} form="detail" />
      </section>)}
    </div>
  </Frame>,
  ...Object.entries(origins).filter(([name]) => ['local', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  <Frame name="node-task-filter"><NodeTaskFilter /></Frame>,
  <Frame name="tasks-empty" width={360} height={180}><TasksEmpty /></Frame>,
  ...['finished', 'offline'].map(id => <Frame name={`task-summary-${id}`} width={260}>
    <TaskCard task={tasks.find(task => task.id === id)!} form="summary" />
  </Frame>),
  ...snapshotForms.map(({ name, id }) => <Frame name={`task-snapshot-${name}`} width={260}>
    <TaskCard task={tasks.find(task => task.id === id)!} form="detail" />
  </Frame>),
  <Frame name="task-snapshot-narrow" width={171}><TaskCard task={tasks[2]} form="detail" /></Frame>,
];

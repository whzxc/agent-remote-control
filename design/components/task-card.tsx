import { Frame, Icon } from 'adg';
import { BrandMark, type Brand } from './brand-mark';
import { ProjectLabel } from './project-path';
import { DispatchSpec } from './dispatch-spec';
import type { TaskStep, TaskPlan, TaskChange } from '../modules/homepage-scene';
import { tasks, origins, snapshotForms, auroraForms, tasksCopy as copy, taskStatuses } from '../fixtures/tasks';


export type OriginStep = { label: string; caption?: string; brand?: Brand; icon?: string };

export type TaskGroup = 'needs-me' | 'running' | 'unread' | 'recent';
export type TaskPreviewLine = { text: string; kind: 'source' | 'agent' | 'thinking' | 'tool' };

export type TaskSnapshotData = {
  id: string; node: string; title: string; group: TaskGroup;
  state: string; detail: string; icon: string; origin: readonly OriginStep[];
  activity?: string; elapsed?: string; lastSeen?: string; exception?: 'failed' | 'interrupted'; turns?: number; phase?: 'thinking' | 'command' | 'file' | 'tool' | 'text'; path?: string; steps?: readonly TaskStep[]; plan?: TaskPlan;
  project?: Parameters<typeof ProjectLabel>[0];
  change?: TaskChange; partial?: boolean; prompt?: string;
  snapshot?: readonly TaskStep[]; dispatch?: Parameters<typeof DispatchSpec>[0];
  previewLines?: readonly TaskPreviewLine[];
  requestLabel?: string;
};


export function OriginChain({ steps }: { steps: readonly OriginStep[] }) {
  return <span class="inline-flex items-center gap-1 text-text-secondary"
    role="img" aria-label={steps.map(s => s.label).join(' → ')}>
    {steps.map((step, i) => <span class="inline-flex items-center gap-1" title={step.label}>
      {i > 0 && <Icon name="arrow-right" size={11} class="text-text-tertiary" />}
      <span class="flex size-4 items-center justify-center">
        {step.brand ? <BrandMark brand={step.brand} size={14} /> : <Icon name={step.icon!} size={13} />}
      </span>
      {(step.icon || step.caption) && (
        <span class="whitespace-nowrap text-caption font-semibold">{step.caption ?? step.label}</span>
      )}
    </span>)}
  </span>;
}

const scrollRow = 'min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

export const aurora = 'border-transparent [background:linear-gradient(var(--surface),var(--surface))_padding-box,conic-gradient(from_24deg,var(--border)_0deg,var(--border)_25deg,var(--aurora-tint)_75deg,var(--border)_142deg,var(--border)_215deg,var(--aurora-tint)_275deg,var(--border)_360deg)_border-box] [box-shadow:var(--shadow-md),0_0_15px_color-mix(in_srgb,var(--aurora-tint)_24%,transparent)]';


export function TaskCardHeader({ task, heading = false, attention = false, metaAction }: { task: TaskSnapshotData; heading?: boolean; attention?: boolean; metaAction?: unknown }) {
  const timing = task.elapsed ?? task.lastSeen;
  const hasMeta = Boolean(task.dispatch || task.project || task.turns !== undefined || metaAction);
  const hasPills = Boolean(task.dispatch || task.project || metaAction);
  const title = 'block w-max whitespace-nowrap text-left text-body leading-5 font-semibold text-text';
  const attentionDot = task.group === 'needs-me' || attention ? 'bg-warning' : task.group === 'unread' ? 'bg-accent' : '';
  return <header class={`flex w-full min-w-0 flex-col gap-2 py-3 ${heading ? "" : "px-[14px]"}`}>
    <div class="flex h-5 min-w-0 items-center justify-between gap-2">
      <div class={`flex-1 ${scrollRow}`}><div class="flex w-max"><OriginChain steps={task.origin} /></div></div>
      <div class="flex shrink-0 items-center gap-[6px]">
        {task.exception && (
          <span class={`whitespace-nowrap rounded-full border px-[7px] text-caption leading-[18px] font-semibold ${
            task.exception === 'failed'
              ? 'border-danger/25 bg-danger/10 text-danger'
              : 'border-warning/25 bg-warning/10 text-warning'
          }`}>
            {task.exception === 'failed' ? 'Failed' : 'Interrupted'}
          </span>
        )}
        {!task.exception && attentionDot && <span class={`size-[6px] rounded-full ${attentionDot}`} aria-hidden="true" />}
        {timing && <time class="whitespace-nowrap text-caption tabular-nums text-text-tertiary">{timing}</time>}
      </div>
    </div>
    <div class={scrollRow}>{heading ? <h2 class={title}>{task.title}</h2>
      : <button aria-label={`${copy.open}: ${task.title}`} class={title}>{task.title}</button>}</div>
    {hasMeta && (
      <div class="flex min-w-0 items-center gap-[6px]">
        <div class={`flex-1 ${scrollRow}`}>
          <div class={`flex w-max items-center gap-[6px] whitespace-nowrap ${hasPills ? 'h-6' : 'h-4'}`}>
            {task.dispatch && <DispatchSpec {...task.dispatch} />}
            {task.project && <ProjectLabel {...task.project} />}
            {task.turns !== undefined && (
              <span class="text-caption tabular-nums text-text-tertiary">
                {task.turns} {task.turns === 1 ? 'turn' : 'turns'}
              </span>
            )}
          </div>
        </div>
        {metaAction && <div class="flex shrink-0 items-center">{metaAction}</div>}
      </div>
    )}
  </header>;
}


function SnapshotNote({ tone, label, text }: { tone: 'source' | 'request'; label?: string; text?: string }) {
  if (tone === 'source') {
    return (
      <p class="border-l-2 border-border-strong pl-2 text-caption leading-4 text-text-tertiary line-clamp-2">
        {text}
      </p>
    );
  }
  return <div class="shrink-0 rounded-[8px] border border-warning/30 bg-surface px-[10px] py-2">
    {label && (
      <span class="flex items-center gap-[5px] text-caption font-semibold leading-4 text-warning">
        <Icon name="shield-alert" size={12} />{label}
      </span>
    )}
    <p class={`${label ? 'mt-0.5' : ''} text-caption leading-4 font-medium text-text line-clamp-2`}>{text}</p>
  </div>;
}


/** Shared task card in exactly two forms: summary (metadata header) and detail (header + structured preview). */
export function TaskCard({ task, form, attention = false, emptyBody, metaAction, footer, class: extra = '' }: {
  task: TaskSnapshotData; form: 'summary' | 'detail'; attention?: boolean; emptyBody?: unknown; metaAction?: unknown; footer?: unknown; class?: string;
}) {
  const preview = form === 'detail';
  const phase = task.phase ?? (task.icon === 'brain' ? 'thinking' : task.icon === 'terminal' ? 'command' : undefined);
  const active = preview && task.group === 'running';
  const waiting = task.group === 'needs-me', done = task.group === 'unread';
  const tint = phase ? `var(--phase-${phase})` : 'var(--role-agent)';
  const steps = (task.snapshot ?? task.steps ?? []).slice(-10), route = taskStatuses[task.id];
  const categories = [
    ['editing', 'Edited', 'file'], ['reading', 'Read', 'file'], ['command', 'Ran', 'command'],
  ] as const;
  const work = categories.flatMap(([kind, verb, unit]) => {
    const count = steps.filter(step => step.kind === kind).length;
    return count ? [`${verb} ${count} ${unit}${count === 1 ? '' : 's'}`] : [];
  }).join(' · ');
  const shell = active ? aurora
    : preview && waiting ? 'border-warning/45 bg-surface shadow-md'
    : 'border-border bg-surface shadow-md';
  const boundedLines = task.previewLines?.slice(footer ? -3 : -4);
  const previewMargin = footer ? 'mb-[6px]' : 'mb-2';
  const agentClamp = (boundedLines?.length ?? 0) <= 2 ? 'line-clamp-3' : 'line-clamp-2';
  return <article aria-label={task.title} style={{ '--aurora-tint': active ? tint : undefined }}
    class={`flex w-full min-w-0 flex-col rounded-card border ${shell} ${extra}`}>
    <TaskCardHeader task={task} attention={attention} metaAction={metaAction} />
    {preview && emptyBody ? (
      <div class={`mx-2 ${previewMargin} flex min-h-[88px] flex-1 flex-col justify-center overflow-hidden rounded-tile bg-surface-subtle p-[10px]`}>
        {emptyBody}
      </div>
    ) : preview && boundedLines ? (
      <div class={`mx-2 ${previewMargin} flex min-h-10 flex-1 flex-col justify-start overflow-hidden rounded-tile bg-surface-subtle`}>
        <div class="flex shrink-0 flex-col gap-2 p-[10px]">
          {boundedLines.map(({ text, kind }) => kind === 'source' ? <SnapshotNote tone="source" text={text} />
            : kind === 'agent' ? <p class={`${agentClamp} text-caption leading-4 text-text`}>{text}</p>
            : <div class={`flex items-center gap-[6px] whitespace-nowrap text-caption leading-4 text-text-secondary ${kind === 'tool' ? 'tabular-nums' : ''}`}>
              <Icon name={kind === 'thinking' ? 'brain' : 'wrench'} size={12} class={kind === 'thinking' ? 'text-phase-thinking' : 'text-phase-file'} />
              <span class="min-w-0 truncate">{text}</span>
            </div>)}
          {waiting && <SnapshotNote tone="request" label={task.requestLabel} text={task.detail} />}
        </div>
      </div>
    ) : preview && (
      <div class={`mx-2 ${previewMargin} flex min-h-10 flex-1 flex-col justify-start gap-2 overflow-hidden rounded-tile bg-surface-subtle p-[10px]`}>
        {task.prompt && <SnapshotNote tone="source" text={task.prompt} />}
        {work && <div class="flex items-center gap-[6px] text-caption leading-4 text-text-secondary">
          <Icon name="wrench" size={12} class="shrink-0 text-phase-file" />
          <span class="min-w-0 truncate tabular-nums">{work}</span>
        </div>}
        {steps.some(step => step.kind === 'thinking') && !(done || task.activity) && (
          <div class="flex items-center gap-[6px] text-caption leading-4 text-text-secondary">
            <Icon name="brain" size={12} class="shrink-0 text-phase-thinking" />
            <span class="min-w-0 truncate">{steps.findLast(step => step.kind === 'thinking')?.text}</span>
          </div>
        )}
        {waiting && <SnapshotNote tone="request" label={`Request → ${route?.route ?? ''}`} text={task.detail} />}
        {(done || task.activity) && (
          <p class="text-caption leading-4 text-text line-clamp-3">{task.change?.output ?? task.activity}</p>
        )}
      </div>
    )}
    {footer}
  </article>;
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
  ...Object.entries(origins).filter(([name]) => ['local', 'antigravityToCodex', 'remote', 'member', 'offline'].includes(name))
    .map(([name, steps]) => <Frame name={`origin-chain-${name}`}><OriginChain steps={steps} /></Frame>),
  ...['finished', 'offline'].map(id => <Frame name={`task-summary-${id}`} width={260}>
    <TaskCard task={tasks.find(task => task.id === id)!} form="summary" />
  </Frame>),
  ...snapshotForms.map(({ name, id }) => <Frame name={`task-snapshot-${name}`} width={260}>
    <TaskCard task={tasks.find(task => task.id === id)!} form="detail" />
  </Frame>),
  ...(['failed', 'interrupted'] as const).map(exception => <Frame name={`task-summary-${exception}`} width={260}>
    <TaskCard task={{ ...tasks.find(task => task.id === 'finished')!, exception }} form="summary" />
  </Frame>),
];

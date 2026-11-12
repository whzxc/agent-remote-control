import { Frame, Icon } from 'adg';
import { AgentIcon } from '../components/agent-icon';
import { TaskActivityIcon, type TaskStepKind } from './task-activity';
import { TopologyGroup } from './topology-group';
import { capsuleForms, quotaReadings, stepCopy, accountContrast } from '../fixtures/node-capsule';

export type NodeTaskState = {
  running?: number; attention?: number; unread?: number; unconfirmed?: boolean; steps?: readonly TaskStepKind[];
};
export const capsuleMaximum = { full: 208, compact: 120 };

/** The reserved column width is state-independent. Only the shell and its outer port change. */
export function nodeCapsuleLayout(state?: NodeTaskState, compact = false) {
  const active = !!(state?.unconfirmed || state?.running || state?.attention || state?.unread);
  if (!active) return { width: 48, active: false, shown: [] as TaskStepKind[], hidden: 0, overflow: '' };
  if (state!.unconfirmed) return { width: compact ? 96 : 156, active: true, shown: [], hidden: 0, overflow: '' };
  const count = (n: number) => n > (compact ? 9 : 99) ? compact ? '9+' : '99+' : String(n);
  const segment = (n: number, icon: boolean) => count(n).length * 7 + (icon ? compact ? 10 : 15 : 0);
  let limit = Math.min(state!.steps?.length ?? 0, compact ? 1 : 3);
  let hidden = 0, overflow = '', width = 48;
  for (;;) {
    hidden = (state!.steps?.length ?? 0) - limit;
    overflow = hidden ? `+${hidden > 99 ? '99+' : hidden}` : '';
    const widths = [
      ...(state!.attention ? [segment(state!.attention, !compact)] : []),
      ...(state!.running ? [segment(state!.running, true)] : []),
      ...(limit ? [limit * 12 + (limit - 1) * 3] : []),
      ...(overflow ? [overflow.length * 7] : []), ...(state!.unread ? [6] : []),
    ];
    const payload = widths.reduce((sum, n) => sum + n, 0) + Math.max(0, widths.length - 1) * 3 + 10;
    width = Math.max(compact ? 80 : 96, 48 + payload);
    if (width <= (compact ? capsuleMaximum.compact : capsuleMaximum.full)) break;
    if (limit > 0) { limit--; continue; }
    overflow = '…';
    width -= Math.max(0, hidden ? `+${hidden > 99 ? '99+' : hidden}`.length * 7 - 7 : 0);
    break;
  }
  return { width, active: true, shown: (state!.steps ?? []).slice(0, limit), hidden, overflow };
}

export function NodeCapsule({ state, label, graphic, compact = false, wing = 'right', expanded }: {
  state?: NodeTaskState; label: string; graphic: unknown; compact?: boolean; wing?: 'left' | 'right'; expanded?: boolean;
}) {
  const model = nodeCapsuleLayout(state, compact);
  const count = (n: number) => n > (compact ? 9 : 99) ? compact ? '9+' : '99+' : String(n);
  const summary = state?.unconfirmed ? stepCopy.unconfirmed : [
    state?.attention ? `${state.attention} need me` : '', state?.running ? `${state.running} running` : '',
    state?.unread ? `${state.unread} completed unread` : '', ...(state?.steps ?? []).map(step => stepCopy[step]),
  ].filter(Boolean).join(', ');
  return <span data-free class="relative inline-flex size-12 shrink-0" data-capsule-logo-anchor
    data-spring-stiffness="210" data-spring-damping="26">
    <span class={`absolute top-0 inline-flex h-12 items-center rounded-full motion-reduce:transition-none
      ${wing === 'left' ? 'right-0 flex-row-reverse' : 'left-0'}`}
      style={{ width: model.width }}>
      {model.active && <span class={`pointer-events-none absolute inset-0 rounded-full border bg-surface shadow-sm
        ${state?.unconfirmed ? 'border-dashed border-border-strong' : state?.attention ? 'border-warning/65' : 'border-role-agent/45'}`} />}
      <button aria-label={`Open ${label} panel`} aria-expanded={expanded}
        class="relative z-10 flex size-12 shrink-0 items-center justify-center rounded-full">{graphic}</button>
      {model.active && <button aria-label={`${label}: ${summary}. Open Tasks`} title={summary}
        class="relative z-10 inline-flex h-10 shrink-0 items-center justify-center gap-[3px] overflow-hidden px-[5px]
          font-mono text-caption leading-4 text-role-agent" style={{ width: model.width - 48 }}>
        {state?.unconfirmed ? <><Icon name="circle-help" size={14} />{!compact && <span>{stepCopy.unconfirmed}</span>}</> : <>
          {!!state?.attention && <span class="inline-flex shrink-0 items-center gap-[3px] font-semibold text-warning">
            {!compact && <Icon name="circle-alert" size={12} />}{count(state.attention)}
          </span>}
          {!!state?.running && <span class="inline-flex shrink-0 items-center gap-[3px] font-semibold">
            <span class="inline-flex motion-safe:animate-pulse motion-reduce:animate-none">
              <Icon name="play" size={compact ? 7 : 12} />
            </span>{count(state.running)}
          </span>}
          {model.shown.map(step => <TaskActivityIcon kind={step} size={12} />)}
          {model.hidden > 0 && <span class="shrink-0 text-text-secondary">{model.overflow}</span>}
          {!!state?.unread && <span aria-label={`${state.unread} completed unread`}
            class="size-[6px] shrink-0 rounded-full bg-accent-text" />}
        </>}
      </button>}
    </span>
  </span>;
}

export default () => [
  ...capsuleForms.map(({ name, state, compact, wing }) => {
    const model = nodeCapsuleLayout(state, compact);
    return <Frame name={name} width={model.width} height={48}
      note="Proposed. Logo anchor stays fixed. Width and child ports use the existing topology spring 210/26; reduced motion is direct.">
      <div class="flex h-12" style={{ width: model.width }}>
        {wing === 'left' && <span class="flex-1" />}
        <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
          state={state} compact={compact} wing={wing} />
      </div>
    </Frame>;
  }),
  <Frame name="account-contrast" width={420} height={72}>
    <div class="flex w-[420px] items-start justify-between gap-6 pt-1">
      <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
        state={capsuleForms[1].state} />
      <TopologyGroup {...accountContrast} />
    </div>
  </Frame>,
];

import { Frame, Icon } from 'adg';
import { pillForms, stepCopy } from '../fixtures/topology-task-state';

export type NodeTaskStep = 'reading' | 'editing' | 'command' | 'thinking' | 'waiting';
export type NodeTaskState = {
  running?: number; attention?: number; unread?: number; unconfirmed?: boolean; steps?: readonly NodeTaskStep[];
};
const icons: Record<NodeTaskStep, string> = {
  reading: 'file-search', editing: 'file-pen-line', command: 'terminal', thinking: 'brain', waiting: 'clock-3',
};

/** A fixed overlay envelope, never a topology entity or a layout input. */
export function NodeTaskPill({ state, label, compact = false }: {
  state: NodeTaskState; label: string; compact?: boolean;
}) {
  const large = (state.attention ?? 0) > 9 || (state.running ?? 0) > 9;
  const limit = compact ? large ? 0 : 1 : large ? 2 : 3;
  const shown = state.unconfirmed ? [] : (state.steps ?? []).slice(0, limit);
  const hidden = state.unconfirmed ? 0 : Math.max(0, (state.steps?.length ?? 0) - shown.length);
  const summary = state.unconfirmed ? 'Unconfirmed' : [
    state.attention ? `${state.attention} need me` : '', state.running ? `${state.running} running` : '',
    state.unread ? `${state.unread} completed unread` : '', ...(state.steps ?? []).map(step => stepCopy[step]),
  ].filter(Boolean).join(', ');
  const count = (n: number) => n > (compact ? 9 : 99) ? compact ? '9+' : '99+' : n;
  return <button aria-label={`${label}: ${summary}. Open Tasks`} title={`${label} · ${summary}`}
    class={`inline-flex h-6 min-w-7 w-max shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-[6px]
      bg-canvas text-caption leading-4 shadow-sm ${compact ? 'max-w-[104px]' : 'max-w-[140px]'}
      ${state.unconfirmed ? 'border-dashed border-border-strong text-text-secondary'
        : state.attention ? 'border-warning/65 text-role-agent' : 'border-role-agent/45 text-role-agent'}`}>
    {state.unconfirmed ? <><Icon name="circle-help" size={12} /><span>{stepCopy.unconfirmed}</span></> : <>
      {!!state.attention && <span class="inline-flex shrink-0 items-center gap-[2px] font-semibold text-warning">
        <span class="size-[5px] rounded-full bg-warning" />{count(state.attention)}
      </span>}
      {!!state.running && <span class="inline-flex shrink-0 items-center gap-[2px] font-semibold">
        <Icon name="play" size={10} />{count(state.running)}
      </span>}
      <span class="inline-flex min-w-0 items-center gap-[3px]">
        {shown.map(step => <Icon name={icons[step]} size={11} />)}
        {hidden > 0 && <span class="text-text-secondary">+{hidden}</span>}
      </span>
      {!!state.unread && <span aria-label={`${state.unread} completed unread`}
        class="size-[6px] shrink-0 rounded-full bg-accent-text" />}
    </>}
  </button>;
}

export default () => pillForms.map(({ name, ...props }) => <Frame name={name}><NodeTaskPill {...props} /></Frame>);

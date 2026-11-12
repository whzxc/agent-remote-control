import { Frame, Icon } from 'adg';
import { badgeForms } from '../fixtures/topology-task-state';

export type NodeTaskState = { running?: number; attention?: number; unread?: number; unconfirmed?: boolean };

/** Task-state decoration has no footprint in the topology solver. Activation jumps to execution. */
export function NodeTaskBadge({ state, label }: { state: NodeTaskState; label: string }) {
  const entries = state.unconfirmed ? [
    { icon: 'circle-help', count: undefined, label: 'Unconfirmed', paint: 'bg-surface-sunken text-text-secondary' },
  ] : [
    { icon: 'circle-alert', count: state.attention, label: 'Needs me', paint: 'bg-warning text-canvas' },
    { icon: 'play', count: state.running, label: 'Running', paint: 'bg-role-agent text-canvas' },
    { icon: 'circle-dot', count: state.unread, label: 'Completed unread', paint: 'bg-accent-text text-canvas' },
  ].filter(e => !!e.count);
  return <button aria-label={`${label}: ${entries.map(e => `${e.label}${e.count ? ` ${e.count}` : ''}`).join(', ')}. Open execution`}
    class="inline-flex shrink-0 gap-[2px] rounded-full bg-canvas p-[2px] text-caption leading-4 shadow-sm">
    {entries.map(e => <span class={`inline-flex h-[18px] min-w-[18px] items-center justify-center gap-[2px] rounded-full px-1 ${e.paint}`}>
      <Icon name={e.icon} size={10} />{e.count}
    </span>)}
  </button>;
}

export default () => badgeForms.map(({ name, ...props }) => <Frame name={name}><NodeTaskBadge {...props} /></Frame>);

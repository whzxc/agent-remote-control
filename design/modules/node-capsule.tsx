import { Frame, Icon } from 'adg';
import { AgentIcon, BrandMark, type AgentIconReading } from '../components/agent-icon';
import { TaskActivityIcon, type TaskStepKind } from './task-activity';
import { TopologyGroup } from './topology-group';
import { capsuleForms, quotaReadings, stepCopy, accountContrast } from '../fixtures/node-capsule';

export type NodeTaskState = {
  running?: number; attention?: number; unread?: number; unconfirmed?: boolean; steps?: readonly TaskStepKind[];
};

/** Geometry: the quota ring is the capsule outline. Every item is a 22px disc on a 28px step, so the
 * logo is concentric with the inner cap and the last item with the outer cap. */
const height = 48, radius = 21, step = 28, disc = 22;
const limits = { full: 5, compact: 2 };
export const capsuleMaximum = { full: height + limits.full * step, compact: height + limits.compact * step };

type Item = { kind: 'attention'; count: number } | { kind: 'step'; step: TaskStepKind | 'running' }
  | { kind: 'overflow'; count: number } | { kind: 'unconfirmed' };

/** The reserved column width is state-independent. Only the outline and its outer port change. */
export function nodeCapsuleLayout(state?: NodeTaskState, compact = false) {
  const items: Item[] = [];
  if (state?.unconfirmed) items.push({ kind: 'unconfirmed' });
  else {
    const limit = compact ? limits.compact : limits.full;
    if (state?.attention) items.push({ kind: 'attention', count: state.attention });
    const running = state?.running ?? 0;
    const steps: (TaskStepKind | 'running')[] = running
      ? Array.from({ length: running }, (_, i) => state?.steps?.[i] ?? 'running') : [];
    const room = limit - items.length;
    const shown = steps.length > room ? Math.max(0, room - 1) : steps.length;
    steps.slice(0, shown).forEach(s => items.push({ kind: 'step', step: s }));
    if (steps.length > shown) items.push({ kind: 'overflow', count: steps.length - shown });
  }
  return { width: height + items.length * step, active: items.length > 0, items };
}

/** A point on the stadium centerline at distance d, clockwise from the top of the inner cap. */
function stadium(width: number, r: number) {
  const straight = width - height, arc = Math.PI * r, total = 2 * straight + 2 * arc;
  const at = (d: number): [number, number, number, number] => {
    d = ((d % total) + total) % total;
    if (d < straight) return [24 + d, 24 - r, 0, -1];
    d -= straight;
    if (d < arc) { const a = d / r; return [width - 24 + r * Math.sin(a), 24 - r * Math.cos(a), Math.sin(a), -Math.cos(a)]; }
    d -= arc;
    if (d < straight) return [width - 24 - d, 24 + r, 0, 1];
    d -= straight;
    const a = d / r; return [24 - r * Math.sin(a), 24 + r * Math.cos(a), -Math.sin(a), Math.cos(a)];
  };
  const path = (from: number, to: number) => {
    const n = Math.max(2, Math.ceil(Math.abs(to - from) * 2));
    return Array.from({ length: n + 1 }, (_, i) => at(from + (to - from) * i / n))
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  };
  return { total, at, path };
}

/** The circular quota ring generalized to a stadium. Angles keep their meaning as fractions of the outline. */
function CapsuleRing({ width, readings = [], used = false, dashed = false }: {
  width: number; readings?: readonly AgentIconReading[]; used?: boolean; dashed?: boolean;
}) {
  // The pace trace stays on the idle ring and in the panel; on a straight run it reads as an underline.
  const ring = stadium(width, radius);
  const ranges = ({ 1: [[0, 360]], 2: [[-8, -172], [8, 172]], 3: [[8, 112], [128, 232], [248, 352]] } as
    Record<number, number[][]>)[readings.length];
  const d = (s: { total: number }, angle: number) => s.total * angle / 360;
  return <svg data-free class="pointer-events-none absolute inset-0" width={width} height={height}
    viewBox={`0 0 ${width} ${height}`} fill="none" stroke-width="3" stroke-linecap="round">
    {!ranges && <path d={ring.path(0, ring.total)} stroke="var(--border-strong)"
      stroke-dasharray={dashed ? '4 5' : undefined} />}
    {ranges?.map(([start, end], i) => {
      const { value, color, elapsed } = readings[i];
      const single = readings.length === 1;
      const reverse = readings.length === 2 && !used;
      const time = elapsed !== undefined && single && !used ? 1 - elapsed : elapsed ?? 0;
      const tick = start + (end - start) * time;
                  const [tx, ty, nx, ny] = ring.at(d(ring, tick));
      return <g>
        <path d={ring.path(d(ring, start), d(ring, end))} stroke="var(--border-strong)" />
        <path d={reverse ? ring.path(d(ring, end), d(ring, start)) : ring.path(d(ring, start), d(ring, end))}
          pathLength="100" stroke={color} stroke-dasharray={`${value} 100`} />
        <path d={`M${tx + nx * 2} ${ty + ny * 2}L${tx - nx * 2} ${ty - ny * 2}`}
          stroke="var(--text-secondary)" stroke-width="1.5" />
      </g>;
    })}
  </svg>;
}

const stepTone: Record<TaskStepKind | 'running', string> = {
  reading: 'text-phase-file', editing: 'text-phase-file', command: 'text-phase-command',
  thinking: 'text-phase-thinking', waiting: 'text-text-tertiary', running: 'text-role-agent',
};

function CapsuleItem({ item }: { item: Item }) {
  const base = 'flex shrink-0 items-center justify-center rounded-full';
  const size = { width: disc, height: disc };
  if (item.kind === 'attention') return <span style={{ minWidth: disc, height: disc }}
    class={`${base} bg-warning px-[5px] text-caption font-semibold tabular-nums text-canvas`}>
    {item.count > 9 ? '9+' : item.count}</span>;
  if (item.kind === 'overflow') return <span style={size}
    class={`${base} gap-[2px] bg-surface-sunken text-text-secondary`} aria-label={`${item.count} more running`}>
    {[0, 1, 2].map(() => <span class="size-[3px] rounded-full bg-current" />)}</span>;
  if (item.kind === 'unconfirmed') return <span style={size} class={`${base} text-text-tertiary`}>
    <Icon name="circle-help" size={16} /></span>;
  return <span style={size} class={`${base} bg-surface-subtle ${stepTone[item.step]}`}>
    {item.step === 'running' ? <Icon name="loader" size={13} /> : <TaskActivityIcon kind={item.step} size={13} />}
  </span>;
}

export function NodeCapsule({ state, label, graphic, mark, readings, used, neutralRing = false, compact = false, wing = 'right', expanded }: {
  state?: NodeTaskState; label: string; graphic: unknown; mark?: unknown; readings?: readonly AgentIconReading[];
  used?: boolean; neutralRing?: boolean; compact?: boolean; wing?: 'left' | 'right'; expanded?: boolean;
}) {
  const model = nodeCapsuleLayout(state, compact);
  const summary = state?.unconfirmed ? stepCopy.unconfirmed : [
    state?.attention ? `${state.attention} need me` : '', state?.running ? `${state.running} running` : '',
    state?.unread ? `${state.unread} completed unread` : '', ...(state?.steps ?? []).map(s => stepCopy[s]),
  ].filter(Boolean).join(', ');
  const width = model.width;
  const mirror = wing === 'left';
  const unread = !!state?.unread && !state?.unconfirmed;
  const buttonLeft = 40;
  // The unread mark sits on the outline at 45° of the outer cap.
  const dotX = width - 24 + radius * Math.SQRT1_2, dotY = 24 - radius * Math.SQRT1_2;
  return <span data-free class="relative inline-flex size-12 shrink-0" data-capsule-logo-anchor
    data-spring-stiffness="210" data-spring-damping="26">
    <span class={`absolute top-0 h-12 motion-reduce:transition-none ${mirror ? 'right-0' : 'left-0'}`}
      style={{ width, transform: mirror ? 'scaleX(-1)' : undefined }}>
      {model.active ? <>
        <span class="absolute inset-[1.5px] rounded-full bg-surface shadow-sm" />
        <CapsuleRing width={width} readings={state?.unconfirmed ? undefined : readings} used={used} dashed={state?.unconfirmed} />
        <button aria-label={`Open ${label} panel`} aria-expanded={expanded}
          class={`absolute left-0 top-0 z-10 flex size-12 items-center justify-center rounded-full
            ${state?.unconfirmed ? 'opacity-60' : ''}`}
          style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>{mark ?? graphic}</button>
        <button aria-label={`${label}: ${summary}. Open Tasks`} title={summary}
          class="absolute top-0 z-10 h-12 rounded-r-full" style={{ left: buttonLeft, width: width - buttonLeft }}>
          {model.items.map((item, i) => <span class="absolute flex h-[22px] items-center justify-center"
            style={{ left: 24 + (i + 1) * step - disc / 2 - buttonLeft, top: (height - disc) / 2, width: disc,
              transform: mirror ? 'scaleX(-1)' : undefined }}><CapsuleItem item={item} /></span>)}
        </button>
      </> : <span class="absolute left-0 top-0 flex size-12" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        {neutralRing && <CapsuleRing width={48} />}
        {graphic}</span>}
      {unread && <span aria-label={`${state!.unread} completed unread`}
        class="absolute z-20 size-[9px] rounded-full border-2 border-canvas bg-accent-text"
        style={{ left: (model.active ? dotX : 24 + radius * Math.SQRT1_2) - 4.5,
          top: dotY - 4.5 }} />}
    </span>
  </span>;
}

export default () => [
  ...capsuleForms.map(({ name, state, compact, wing }) => {
    const model = nodeCapsuleLayout(state, compact);
    return <Frame name={name} width={model.width} height={48}
      note="Proposed. The quota ring is the capsule outline. Logo anchor stays fixed; width and the outer port use the topology spring 210/26; reduced motion is direct.">
      <div class="flex h-12" style={{ width: model.width }}>
        {wing === 'left' && <span class="flex-1" />}
        <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
          mark={<BrandMark brand="codex" size={28} />} readings={quotaReadings}
          state={state} compact={compact} wing={wing} />
      </div>
    </Frame>;
  }),
  <Frame name="account-contrast" width={420} height={72}>
    <div class="flex w-[420px] items-start justify-between gap-6 pt-1">
      <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
        mark={<BrandMark brand="codex" size={28} />} readings={quotaReadings} state={capsuleForms[1].state} />
      <TopologyGroup {...accountContrast} />
    </div>
  </Frame>,
];

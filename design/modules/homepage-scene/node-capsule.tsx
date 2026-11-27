import type { ReactNode } from "react";
import { type TaskStepKind, TaskActivityIcon } from './task-activity';
import { type AgentIconReading } from './agent-icon';
import { Icon } from 'adg';
import { stepCopy } from '../../fixtures/node-capsule';

export type NodeTaskState = {
  running?: number; attention?: number; unread?: number; exception?: 'failed' | 'interrupted'; steps?: readonly TaskStepKind[];
};

const height = 48, radius = 21, step = 28, disc = 20;

const limits = { full: 5, compact: 2 };

export const capsuleMaximum = { full: height + limits.full * step, compact: height + limits.compact * step };

type Item = { kind: 'attention' } | { kind: 'step'; step: TaskStepKind | 'running' }
  | { kind: 'overflow' } | { kind: 'failed' } | { kind: 'interrupted' };

export function nodeCapsuleLayout(state?: NodeTaskState, compact = false) {
  const items: Item[] = [];
  const limit = compact ? limits.compact : limits.full;
  if (state?.attention) items.push({ kind: 'attention' });
  if (state?.exception) items.push({ kind: state.exception });
  const room = limit - items.length;
  const running = state?.running ?? 0;
  const shown = running > room ? Math.max(0, room - 1) : running;
  for (let index = 0; index < shown; index++) items.push({ kind: 'step', step: state?.steps?.[index] ?? 'running' });
  if (room && running > shown) items.push({ kind: 'overflow' });
  return { width: height + items.length * step, active: items.length > 0, items };
}

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

function CapsuleRing({ width, readings = [], used = false }: {
  width: number; readings?: readonly AgentIconReading[]; used?: boolean;
}) {
  // The pace trace stays on the idle ring and in the panel; on a straight run it reads as an underline.
  const ring = stadium(width, radius);
  const ranges = ({ 1: [[0, 360]], 2: [[-8, -172], [8, 172]], 3: [[8, 112], [128, 232], [248, 352]] } as
    Record<number, number[][]>)[readings.length];
  const d = (s: { total: number }, angle: number) => s.total * angle / 360;
  return <svg data-free className="pointer-events-none absolute inset-0" width={width} height={height}
    viewBox={`0 0 ${width} ${height}`} fill="none" strokeWidth="3" strokeLinecap="round">
    {!ranges && <path d={ring.path(0, ring.total)} stroke="var(--border-strong)" />}
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
          pathLength="100" stroke={color} strokeDasharray={`${value} 100`} />
        <path d={`M${tx + nx * 2} ${ty + ny * 2}L${tx - nx * 2} ${ty - ny * 2}`}
          stroke="var(--text-secondary)" strokeWidth="1.5" />
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
  if (item.kind === 'attention') return <span style={size} className={`${base} bg-warning text-canvas`}>
    <Icon name="shield-alert" size={12} /></span>;
  if (item.kind === 'overflow') return <span style={size}
    className={`${base} bg-surface-sunken text-text-secondary`}><Icon name="ellipsis" size={13} /></span>;
  if (item.kind === 'failed' || item.kind === 'interrupted') return <span style={size}
    className={`${base} bg-surface-subtle ${item.kind === 'failed' ? 'text-danger' : 'text-warning'}`}>
    <Icon name={item.kind === 'failed' ? 'circle-x' : 'circle-pause'} size={12} /></span>;
  return <span style={size} className={`${base} bg-surface-subtle ${stepTone[item.step]}`}>
    {item.step === 'running' ? <Icon name="loader" size={12} /> : <TaskActivityIcon kind={item.step} size={12} />}
  </span>;
}

export function NodeCapsule({ state, label, graphic, mark, readings, used, neutralRing = false, compact = false, wing = 'right', expanded }: {
  state?: NodeTaskState; label: string; graphic: ReactNode; mark?: ReactNode; readings?: readonly AgentIconReading[];
  used?: boolean; neutralRing?: boolean; compact?: boolean; wing?: 'left' | 'right'; expanded?: boolean;
}) {
  const model = nodeCapsuleLayout(state, compact);
  const summary = [
    state?.exception ? stepCopy[state.exception] : '',
    state?.attention ? `${state.attention} need me` : '', state?.running ? `${state.running} running` : '',
    state?.unread ? `${state.unread} completed unread` : '', ...(state?.steps ?? []).map(s => stepCopy[s]),
  ].filter(Boolean).join(', ');
  const width = model.width;
  const mirror = wing === 'left';
  const buttonLeft = 40;
  return <span data-free className="relative inline-flex size-12 shrink-0" data-capsule-logo-anchor
    data-spring-stiffness="210" data-spring-damping="26">
    <span className={`absolute top-0 h-12 motion-reduce:transition-none ${mirror ? 'right-0' : 'left-0'}`}
      style={{ width, transform: mirror ? 'scaleX(-1)' : undefined }}>
      {model.active ? <>
        <span className="absolute inset-[1.5px] rounded-full bg-surface shadow-sm" />
        <CapsuleRing width={width} readings={readings} used={used} />
        <button aria-label={`Open ${label} panel`} aria-expanded={expanded}
          className="absolute left-0 top-0 z-10 flex size-12 items-center justify-center rounded-full"
          style={{ transform: mirror ? 'scaleX(-1)' : undefined }}><span className="flex scale-[.92]">{mark ?? graphic}</span></button>
        <button aria-label={`${label}: ${summary}. Open Tasks`} title={summary}
          className="absolute top-0 z-10 h-12 rounded-r-full" style={{ left: buttonLeft, width: width - buttonLeft }}>
          {model.items.map((item, i) => <span className="absolute flex size-5 items-center justify-center"
            style={{ left: 24 + (i + 1) * step - disc / 2 - buttonLeft, top: (height - disc) / 2, width: disc,
              transform: mirror ? 'scaleX(-1)' : undefined }}><CapsuleItem item={item} /></span>)}
        </button>
      </> : <span className="absolute left-0 top-0 flex size-12" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        {neutralRing && <CapsuleRing width={48} />}
        {graphic}</span>}

    </span>
  </span>;
}

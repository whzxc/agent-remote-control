export type { NodeTaskState } from '../../state/activityModel';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { integrateSpring } from '../../topology/spring';
import { Brain, CircleHelp, Clock3, Ellipsis, FilePenLine, FileSearch, Loader, Terminal } from 'lucide-react';
import { Icon, Tooltip } from './index';
import { useMedia } from '../../state/hooks';
import { t } from '../../i18n';
import type { AgentIconReading } from './agent-icon';
import { capsuleItems, type NodeTaskState } from '../../state/activityModel';
import './NodeCapsule.css';

export const taskPhaseIcons = { reading: FileSearch, editing: FilePenLine, command: Terminal, thinking: Brain, waiting: Clock3, running: Loader };
function stadium(width: number) {
  const radius = 21, straight = width - 48, arc = Math.PI * radius, total = 2 * straight + 2 * arc;
  const at = (distance: number) => {
    let d = ((distance % total) + total) % total;
    if (d < straight) return [24 + d, 3, 0, -1];
    d -= straight;
    if (d < arc) { const angle = d / radius; return [width - 24 + radius * Math.sin(angle), 24 - radius * Math.cos(angle), Math.sin(angle), -Math.cos(angle)]; }
    d -= arc;
    if (d < straight) return [width - 24 - d, 45, 0, 1];
    d -= straight;
    const angle = d / radius;
    return [24 - radius * Math.sin(angle), 24 + radius * Math.cos(angle), -Math.sin(angle), Math.cos(angle)];
  };
  const path = (from: number, to: number) => {
    const count = Math.max(2, Math.ceil(Math.abs(to - from) * 2));
    return Array.from({ length: count + 1 }, (_, index) => at(from + (to - from) * index / count))
      .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  };
  return { total, at, path };
}
function CapsuleRing({ width, readings = [], used, dashed }: { width: number; readings?: readonly AgentIconReading[]; used?: boolean; dashed?: boolean }) {
  const ring = stadium(width), distance = (angle: number) => ring.total * angle / 360;
  const ranges = ({ 1: [[0, 360]], 2: [[-8, -172], [8, 172]], 3: [[8, 112], [128, 232], [248, 352]] } as Record<number, number[][]>)[readings.length];
  return <svg className="node-capsule-ring" width={width} height={48} viewBox={`0 0 ${width} 48`} fill="none" strokeWidth={3} strokeLinecap="round" aria-hidden="true">
    {!ranges && <path d={ring.path(0, ring.total)} stroke="var(--border-strong)" strokeDasharray={dashed ? '4 5' : undefined} />}
    {ranges?.map(([start, end], index) => {
      const reading = readings[index], time = readings.length === 1 && !used && reading.elapsed !== undefined ? 1 - reading.elapsed : reading.elapsed ?? 0;
      const [x, y, nx, ny] = ring.at(distance(start + (end - start) * time));
      return <g key={reading.id}><path d={ring.path(distance(start), distance(end))} stroke="var(--border-strong)" />
        <path d={readings.length === 2 && !used ? ring.path(distance(end), distance(start)) : ring.path(distance(start), distance(end))}
          pathLength={100} stroke={reading.color} strokeDasharray={`${reading.value} 100`} />
        <path d={`M${x + nx * 2} ${y + ny * 2}L${x - nx * 2} ${y - ny * 2}`} stroke="var(--text-secondary)" strokeWidth={1.5} />
      </g>;
    })}
  </svg>;
}
export function NodeCapsule({ label, state, graphic, mark, neutralRing, readings, used, compact = false, wing = 'right', expanded, onOpen, onTasks, onWidth, onMove }: {
  neutralRing?: boolean; label: string; state: NodeTaskState; graphic: ReactNode; mark?: ReactNode; readings?: readonly AgentIconReading[]; used?: boolean;
  compact?: boolean; wing?: 'left' | 'right'; expanded?: boolean; onOpen: () => void; onTasks: () => void; onWidth?: (width: number) => void; onMove?: (by: number) => void;
}) {
  const items = capsuleItems(state, compact), target = 48 + 28 * items.length;
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const spring = useRef({ x: target, v: 0, t: target });
  const [animatedWidth, setAnimatedWidth] = useState(target);
  useLayoutEffect(() => {
    spring.current.t = target;
    if (reduced) { spring.current = { x: target, v: 0, t: target }; setAnimatedWidth(target); return; }
    let frame = 0, previous = performance.now();
    const step = (now: number) => {
      const moving = integrateSpring(spring.current, Math.min(.032, (now - previous) / 1000), 210, 26);
      previous = now; setAnimatedWidth(Math.max(48, spring.current.x));
      if (moving) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reduced]);
  const width = reduced ? target : animatedWidth;
  useLayoutEffect(() => onWidth?.(width), [width, onWidth]);
  const summary = state.unconfirmed ? t('homepage.unconfirmed') : [state.attention ? t('homepage.attentionCount', { count: state.attention }) : '',
    state.running ? t('homepage.runningCount', { count: state.running }) : '', state.unread ? t('homepage.unreadCount', { count: state.unread }) : '',
    ...state.steps.map(step => t(`homepage.${step ?? 'running'}`))].filter(Boolean).join(', ');
  const mirror = wing === 'left', active = target > 48 || width > 48.1;
  return <span className="node-capsule-anchor" data-wing={wing}>
    <span className="node-capsule" data-unconfirmed={state.unconfirmed || undefined} style={{ width, transform: mirror ? 'scaleX(-1)' : undefined }}>
      {(active || neutralRing) && <>{active && <span className="node-capsule-fill" />}<CapsuleRing width={width} readings={state.unconfirmed ? undefined : readings} used={used} dashed={state.unconfirmed} /></>}
      <button type="button" className="node-capsule-logo" data-panel-anchor data-layer-switcher aria-label={label} aria-expanded={expanded}
        onClick={onOpen} aria-keyshortcuts={onMove ? 'ArrowUp ArrowDown' : undefined}
        onKeyDown={event => { if (onMove && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); onMove(event.key === 'ArrowUp' ? -1 : 1); } }} style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>{active ? mark ?? graphic : graphic}</button>
      {items.length > 0 && <Tooltip text={summary}><button type="button" className="node-capsule-tasks" aria-label={`${label}. ${summary}. ${t('homepage.openTasks')}`} onClick={onTasks}>
        <span className="node-capsule-items" style={{ opacity: Math.max(0, Math.min(1, (width - 48) / Math.max(1, target - 48))) }}>
          {items.map((item, index) => <span key={index} className="node-capsule-disc" data-kind={item.kind} data-phase={item.kind === 'step' ? item.step ?? 'running' : undefined}
            style={{ left: 24 + (index + 1) * 28 - 11 - 40, transform: mirror ? 'scaleX(-1)' : undefined }}>
            {item.kind === 'attention' ? item.count > 9 ? '9+' : item.count : <Icon size={item.kind === 'unconfirmed' ? 16 : 13}
              icon={item.kind === 'overflow' ? Ellipsis : item.kind === 'unconfirmed' ? CircleHelp : taskPhaseIcons[item.step ?? 'running']} />}
          </span>)}
        </span>
      </button></Tooltip>}
      {!!state.unread && !state.unconfirmed && <span role="img" aria-label={t('homepage.unreadCount', { count: state.unread })} className="node-capsule-unread"
        style={{ left: width - 24 + 21 * Math.SQRT1_2 - 4.5, top: 24 - 21 * Math.SQRT1_2 - 4.5 }} />}
    </span>
  </span>;
}

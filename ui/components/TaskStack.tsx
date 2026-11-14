import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useReducedMotion } from '../state/appEnvironment';
import { integrateSpring } from '../topology/spring';
import { deckGeometry, deckRelease } from './taskDeck';
import { previewHomepageTask, type HomepageTask } from '../state/activityModel';
import { taskTitle } from './ui/TaskSnapshot';

export default function TaskStack({ tasks, activeCount, label, render, onOpen }: {
  tasks: HomepageTask[]; activeCount: number; label: string; render: (task: HomepageTask, tabbable: boolean, detailed: boolean) => ReactNode; onOpen: (task: HomepageTask) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0), [position, setPosition] = useState(0), [settling, setSettling] = useState(false);
  const value = useRef(0), frame = useRef(0), target = useRef(0), wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const drag = useRef<{ id: number; start: number; position: number; last: number; at: number; velocity: number; moved: boolean }>(undefined);
  const suppressClick = useRef(false), reduced = useReducedMotion();
  const peek = width < 500 ? 34 : width < 1000 ? 70 : 132;
  const cardWidth = width < 500 ? Math.min(290, Math.max(0, width - 48)) : width < 1000 ? 340 : 360;
  const stride = cardWidth + 16;
  const hasHistory = activeCount < tasks.length;
  const spreadCount = activeCount > 0 && activeCount * stride + 16 + (hasHistory ? peek : 0) <= width
    ? activeCount - 1 : 0;
  const spread = Math.max(0, spreadCount - position / stride);
  const active = Math.max(0, Math.min(tasks.length - 1, Math.round(position / stride)));
  const first = Math.max(0, Math.floor(position / stride));
  const start = Math.max(0, first - Math.ceil(width / stride) - 1), end = Math.min(tasks.length, Math.max(first + 8, spreadCount + 8));
  const cards = useMemo(() => tasks.slice(start, end).map((task, offset) => {
    const index = start + offset, detailed = index <= spreadCount || (index >= Math.max(0, active - 1) && index < Math.max(0, active - 1) + 5);
    return { task, index, content: render(task, index === active, detailed) };
  }).reverse(), [tasks, render, start, end, active, spreadCount]);
  const set = (next: number) => { value.current = next; setPosition(next); };
  const stop = () => { cancelAnimationFrame(frame.current); setSettling(false); };
  function settle(next: number, velocity = 0) {
    stop(); target.current = next;
    if (reduced) { set(next); return; }
    setSettling(true);
    const spring = { x: value.current, v: velocity * 1000, t: next };
    let last = performance.now();
    const tick = (now: number) => {
      integrateSpring(spring, Math.min((now - last) / 1000, .032), 240, 30); last = now;
      set(spring.x);
      if (spring.x !== spring.t || spring.v !== 0) frame.current = requestAnimationFrame(tick);
      else setSettling(false);
    };
    frame.current = requestAnimationFrame(tick);
  }
  useLayoutEffect(() => {
    const node = host.current!;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    setWidth(node.clientWidth); observer.observe(node); return () => observer.disconnect();
  }, []);
  const keys = useMemo(() => tasks.map(task => task.key), [tasks]);
  const identities = useMemo(() => keys.join('\n'), [keys]);
  const frontIsPreview = tasks.length > 0 && previewHomepageTask(tasks[0]);
  const previous = useRef({ keys, stride, frontIsPreview });
  useLayoutEffect(() => {
    stop(); clearTimeout(wheelTimer.current);
    const previousIndex = Math.round(value.current / previous.current.stride);
    const key = previous.current.keys[previousIndex];
    const match = tasks.findIndex(task => task.key === key);
    const justRead = previous.current.frontIsPreview && match >= 0 && tasks[match].group === 'recent';
    const index = previousIndex === 0 && !justRead ? 0 : Math.max(0, match);
    set(index * stride); target.current = index * stride;
    previous.current = { keys, stride, frontIsPreview };
  }, [identities, stride, frontIsPreview]);
  const state = useRef({ stride, count: tasks.length }); state.current = { stride, count: tasks.length };
  const controls = useRef({ settle }); controls.current = { settle };
  useEffect(() => { if (reduced) { stop(); set(target.current); } }, [reduced]);
  useEffect(() => {
    const node = host.current!;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || drag.current || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const { stride, count } = state.current;
      const delta = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      const next = Math.max(0, Math.min((count - 1) * stride, value.current - delta));
      if (next === value.current) return;
      event.preventDefault(); stop(); clearTimeout(wheelTimer.current);
      set(next);
      wheelTimer.current = setTimeout(() => controls.current.settle((delta < 0 ? Math.ceil(value.current / stride) : Math.floor(value.current / stride)) * stride), 100);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); stop(); clearTimeout(wheelTimer.current); };
  }, []);
  const span = cardWidth + deckGeometry(Math.min(tasks.length - 1, spreadCount + 7), peek, stride, spreadCount).offset;
  const minimumSpan = cardWidth + spreadCount * stride + (spreadCount && hasHistory ? peek : 0);
  const front = Math.min(width - cardWidth - 16, Math.max(minimumSpan - cardWidth + 16, (width + span) / 2 - cardWidth));
  function release(cancelled = false) {
    const held = drag.current; if (!held) return;
    drag.current = undefined;
    const velocity = cancelled || performance.now() - held.at > 100 ? 0 : held.velocity;
    if (held.moved) { suppressClick.current = true; settle(deckRelease(value.current, velocity, stride, tasks.length), velocity); }
  }
  return <div ref={host} className="task-stack" role="list" aria-busy={settling} aria-label={label} tabIndex={0}
    aria-keyshortcuts="ArrowLeft ArrowRight Enter" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); settle(Math.max(0, Math.min(tasks.length - 1, Math.round(target.current / stride) + (event.key === 'ArrowRight' ? 1 : -1))) * stride);
      } else if (event.key === 'Enter' && event.target === event.currentTarget && tasks[active]) { event.preventDefault(); onOpen(tasks[active]); }
    }} onPointerDown={event => {
      if (event.button !== 0) return;
      stop(); clearTimeout(wheelTimer.current); suppressClick.current = false;
      drag.current = { id: event.pointerId, start: event.clientX, position: value.current, last: event.clientX, at: performance.now(), velocity: 0, moved: false };
    }} onPointerMove={event => {
      const held = drag.current; if (!held || held.id !== event.pointerId) return;
      const dx = event.clientX - held.start, now = performance.now();
      if (Math.abs(dx) > 4) { held.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
      if (!held.moved) return;
      held.velocity = (event.clientX - held.last) / Math.max(1, now - held.at);
      held.last = event.clientX; held.at = now;
      set(Math.max(0, Math.min((tasks.length - 1) * stride, held.position + dx)));
    }} onPointerUp={() => release()} onPointerCancel={() => release(true)} onLostPointerCapture={() => release(true)}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
    {cards.map(({ task, index, content }) => {
      const depth = index - position / stride, geometry = deckGeometry(depth, peek, stride, spread);
      return <article key={task.key} className="task-stack-card" aria-label={taskTitle(task)} aria-current={index === active ? 'true' : undefined}
        inert={geometry.opacity === 0} data-summary={!previewHomepageTask(task) || undefined}
        style={{ left: front - geometry.offset, width: cardWidth, zIndex: tasks.length - index,
          transform: `scale(${geometry.scale})`, opacity: geometry.opacity,
          '--task-strip': `${Math.min(cardWidth, geometry.strip)}px`, '--task-fog': geometry.fog } as CSSProperties}
        data-labelled={geometry.strip >= 100 || undefined} onClick={event => { if (!(event.target as HTMLElement).closest('button')) onOpen(task); }}>
        {content}
      </article>;
    })}
  </div>;
}

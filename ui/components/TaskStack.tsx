import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useReducedMotion } from '../state/appEnvironment';
import { integrateSpring } from '../topology/spring';
import { deckGeometry, deckRelease } from './taskDeck';
import { t } from '../i18n';
import type { HomepageTask } from '../state/activityModel';
import { taskTitle } from './ui/TaskSnapshot';

export default function TaskStack({ tasks, render, onOpen }: {
  tasks: HomepageTask[]; render: (task: HomepageTask, tabbable: boolean) => ReactNode; onOpen: (task: HomepageTask) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0), [position, setPosition] = useState(0), [settling, setSettling] = useState(false);
  const value = useRef(0), frame = useRef(0), target = useRef(0), wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const drag = useRef<{ id: number; start: number; position: number; last: number; at: number; velocity: number; moved: boolean }>(undefined);
  const suppressClick = useRef(false), reduced = useReducedMotion();
  const stride = width < 500 ? 34 : width < 1000 ? 70 : 132;
  const cardWidth = width < 500 ? Math.min(290, width - 48) : width < 1000 ? 340 : 360;
  const active = Math.max(0, Math.min(tasks.length - 1, Math.round(position / stride)));
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
  const identities = tasks.map(task => task.key).join('\n');
  const previous = useRef({ keys: tasks.map(task => task.key), stride });
  useLayoutEffect(() => {
    stop(); clearTimeout(wheelTimer.current);
    const key = previous.current.keys[Math.round(value.current / previous.current.stride)];
    const index = Math.max(0, tasks.findIndex(task => task.key === key));
    set(index * stride); target.current = index * stride;
    previous.current = { keys: tasks.map(task => task.key), stride };
  }, [identities, stride]);
  const state = useRef({ stride, count: tasks.length }); state.current = { stride, count: tasks.length };
  const controls = useRef({ settle }); controls.current = { settle };
  useEffect(() => { if (reduced) { stop(); set(target.current); } }, [reduced]);
  useEffect(() => {
    const node = host.current!;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || drag.current) return;
      event.preventDefault(); stop(); clearTimeout(wheelTimer.current);
      const { stride, count } = state.current;
      const delta = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      set(Math.max(0, Math.min((count - 1) * stride, value.current - delta)));
      wheelTimer.current = setTimeout(() => controls.current.settle(deckRelease(value.current, 0, stride, count)), 100);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => { node.removeEventListener('wheel', wheel); stop(); clearTimeout(wheelTimer.current); };
  }, []);
  const span = cardWidth + deckGeometry(Math.min(tasks.length - 1, 7), stride).offset;
  const front = Math.min((width - span) / 2, width - span - 16) + span - cardWidth;
  function release(cancelled = false) {
    const held = drag.current; if (!held) return;
    drag.current = undefined;
    const velocity = cancelled || performance.now() - held.at > 100 ? 0 : held.velocity;
    if (held.moved) { suppressClick.current = true; settle(deckRelease(value.current, velocity, stride, tasks.length), velocity); }
  }
  return <div ref={host} className="task-stack" role="list" aria-busy={settling} aria-label={t('homepage.tasks')} tabIndex={0}
    aria-keyshortcuts="ArrowLeft ArrowRight Enter" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); settle(Math.max(0, Math.min(tasks.length - 1, Math.round(target.current / stride) + (event.key === 'ArrowRight' ? 1 : -1))) * stride);
      } else if (event.key === 'Enter' && event.target === event.currentTarget && tasks[active]) { event.preventDefault(); onOpen(tasks[active]); }
    }} onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('footer button')) return;
      stop(); clearTimeout(wheelTimer.current); suppressClick.current = false;
      drag.current = { id: event.pointerId, start: event.clientX, position: value.current, last: event.clientX, at: performance.now(), velocity: 0, moved: false };
    }} onPointerMove={event => {
      const held = drag.current; if (!held || held.id !== event.pointerId) return;
      const dx = event.clientX - held.start, now = performance.now();
      if (Math.abs(dx) > 4) { held.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
      if (!held.moved) return;
      held.velocity = (event.clientX - held.last) / Math.max(1, now - held.at);
      held.last = event.clientX; held.at = now;
      set(held.position + dx);
    }} onPointerUp={() => release()} onPointerCancel={() => release(true)} onLostPointerCapture={() => release(true)}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
    {[...tasks].map((task, index) => ({ task, index })).reverse().map(({ task, index }) => {
      const depth = index - position / stride, geometry = deckGeometry(depth, stride);
      return <article key={task.key} className="task-stack-card" aria-label={taskTitle(task)} aria-current={index === active ? 'true' : undefined}
        inert={geometry.opacity === 0} style={{ left: front - geometry.offset, width: cardWidth, zIndex: tasks.length - index,
          transform: `scale(${geometry.scale})`, opacity: geometry.opacity,
          '--task-strip': `${Math.min(cardWidth, geometry.strip)}px`, '--task-fog': geometry.fog } as CSSProperties}
        data-labelled={geometry.strip >= 100 || undefined} onClick={event => { if (!(event.target as HTMLElement).closest('button')) onOpen(task); }}>
        {render(task, index === active)}
      </article>;
    })}
  </div>;
}

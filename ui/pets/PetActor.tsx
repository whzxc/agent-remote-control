import { useEffect, useImperativeHandle, useRef, useState, type Ref, type CSSProperties } from 'react';
import { t } from '../i18n';
import { scenarioName } from '../scenarioMode';
import { type Point, type PetPackage } from './model';
import { boundPet, type PetSize } from './geometry';
import PetSprite from './PetSprite';
import { reactions, reactionDeck, type PetPose, type PetGesture } from './behavior';
export interface PetActorHandle {
  place: (post: Point, bounds: Point & { top: number }, spawn?: Point, walk?: boolean) => void;
  cue: (row: number, speech?: string, carrying?: boolean, pose?: Pick<PetPose, 'gesture' | 'tempo'>) => void;
  point: () => Point | null;
  available: () => boolean;
  hide: () => void;
}
export default function PetActor({ pet, url, label, tag, animate, slow, row = 0, onClick, roam = false, cardTone, size, ref }: {
  pet: PetPackage; size: PetSize; url: string; label: string; tag?: string; animate: boolean; slow: boolean; row?: number;
  cardTone?: 'neutral' | 'success' | 'danger'; onClick?: () => void; roam?: boolean; ref: Ref<PetActorHandle>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const position = useRef<Point | null>(null), post = useRef<Point>({ x: 0, y: 0 }), bounds = useRef({ x: 0, y: 0, top: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; moved: boolean; origin: Point; mode: 'post' | 'placed' } | null>(null);
  const frame = useRef(0);
  const mode = useRef<'post' | 'drag' | 'placed'>('post');
  const manualUntil = useRef(0), strolling = useRef(false), reacting = useRef(false);
  const reactionTimers = useRef<ReturnType<typeof setTimeout>[]>([]), deck = useRef<number[]>([]), previousReaction = useRef<number | undefined>(undefined);
  const [delay] = useState(() => -Math.random() * 1600);
  const [pose, setPose] = useState<Pick<PetPose, 'gesture' | 'tempo'>>({ gesture: 'still', tempo: 1 });
  const [reactionGesture, setReactionGesture] = useState<PetGesture | null>(null);
  const [action, setAction] = useState<number | null>(null), [line, setLine] = useState(''), [cueRow, setCueRow] = useState(row), [walking, setWalking] = useState<number | null>(null);
  const [carrying, setCarrying] = useState(!!cardTone);
  const lastFrame = useRef(0);
  const latest = useRef({ animate, row }); latest.current = { animate, row };
  const clear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paint = () => { if (button.current && position.current) { button.current.style.transform = `translate(${position.current.x}px, ${position.current.y}px)`; button.current.style.visibility = 'visible'; button.current.style.display = ''; } };
  const clamp = (point: Point) => boundPet(point, bounds.current.x, bounds.current.y, bounds.current.top, size);
  const tick = (time: number) => {
    const elapsed = lastFrame.current ? Math.min(50, time - lastFrame.current) : 16; lastFrame.current = time;
    frame.current = 0;
    if (!position.current || !latest.current.animate || mode.current !== 'post' || reacting.current) return;
    const target = clamp(post.current);
    const p = position.current, dx = target.x - p.x, dy = target.y - p.y;
    if (Math.hypot(dx, dy) < 1) {
      position.current = target; paint();
      setAction(null); setWalking(null);
      return;
    }
    const step = strolling.current ? Math.min(1, elapsed * .055 / Math.hypot(dx, dy)) : 1 - Math.exp(-elapsed / 140);
    setWalking(dx >= 0 ? 1 : 2);
    position.current = { x: p.x + dx * step, y: p.y + dy * step }; paint();
    frame.current = requestAnimationFrame(tick);
  };
  const wake = () => { if (!frame.current && latest.current.animate) { lastFrame.current = 0; frame.current = requestAnimationFrame(tick); } };
  useImperativeHandle(ref, () => ({ place(target, limits, spawn, walk = false) {
    post.current = target; bounds.current = limits;
    strolling.current = walk;
    if (mode.current === 'placed' && roam && latest.current.animate && Date.now() >= manualUntil.current) mode.current = 'post';
    if (!position.current) {
      position.current = clamp(spawn ?? target);
      if (import.meta.env.DEV && scenarioName === 'pets-dragged' && !onClick) {
        position.current = clamp({ x: target.x + 100, y: target.y + 80 }); mode.current = 'drag'; setAction(6); if (button.current) button.current.dataset.dangling = 'true';
      }
    }
    if (!latest.current.animate && mode.current === 'post') position.current = clamp(target);
    else if (mode.current === 'post' && Math.hypot(position.current.x - target.x, position.current.y - target.y) > 2) wake();
    position.current = clamp(position.current); paint();
  }, cue(next, speech, carried, nextPose) {
    setCueRow(next); if (carried !== undefined) setCarrying(carried);
    if (nextPose) setPose(old => old.gesture === nextPose.gesture && old.tempo === nextPose.tempo ? old : nextPose);
    if (speech && !reacting.current) { setLine(speech); clearTimeout(clear.current); clear.current = setTimeout(() => setLine(''), 2400); }
  }, point: () => button.current?.style.display === 'none' ? null : position.current && { x: position.current.x + size.width / 2, y: position.current.y + size.height / 2 },
    available: () => !reacting.current && mode.current !== 'drag' && (mode.current !== 'placed' || roam && Date.now() >= manualUntil.current),
    hide: () => { if (button.current) button.current.style.display = 'none'; cancelAnimationFrame(frame.current); frame.current = 0; } }));
  useEffect(() => {
    if (animate) wake(); else { cancelAnimationFrame(frame.current); frame.current = 0; if (mode.current === 'post' && position.current) { position.current = clamp(post.current); setAction(null); setWalking(null); paint(); } }
  }, [animate]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(clear.current); reactionTimers.current.forEach(clearTimeout); }, []);
  function stopReaction() {
    reactionTimers.current.forEach(clearTimeout); reactionTimers.current = []; reacting.current = false; setReactionGesture(null);
    setAction(null); setLine('');
  }
  function finish(cancel = false) {
    const d = drag.current; if (!d && mode.current !== 'drag') return;
    drag.current = null; if (button.current) delete button.current.dataset.dangling;
    mode.current = d ? cancel || !d.moved ? d.mode : 'placed' : 'post';
    if (d?.moved && !cancel) manualUntil.current = Date.now() + 12000;
    if (cancel && d) position.current = clamp(d.origin);
    setAction(null); setWalking(null);
    if (d && button.current?.hasPointerCapture(d.pointer)) button.current.releasePointerCapture(d.pointer);
    if (mode.current === 'post') {
      if (animate) wake(); else position.current = clamp(post.current);
    }
    paint();
  }
  const suppress = useRef(false);
  return <button style={{ width: size.width, height: size.height + size.tagHeight,
    '--pet-height': `${size.height}px`, '--pet-tag-height': `${size.tagHeight}px`, '--pet-beat': `${1000 * pose.tempo}ms`,
  } as CSSProperties} ref={button} type="button" className="topology-pet" data-motion={animate || undefined} aria-label={label}
    onPointerDown={e => {
      if (e.button !== 0 || !e.isPrimary || !position.current || drag.current) return;
      stopReaction();
      e.stopPropagation(); cancelAnimationFrame(frame.current); frame.current = 0;
      drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false, origin: { ...position.current }, mode: mode.current === 'placed' ? 'placed' : 'post' }; suppress.current = false;
      mode.current = 'drag'; e.currentTarget.dataset.dangling = 'true'; e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => {
      const d = drag.current; if (!d || d.pointer !== e.pointerId || !position.current) return;
      e.stopPropagation(); const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true; suppress.current = true; d.x = e.clientX; d.y = e.clientY;
      setAction(6); position.current = clamp({ x: position.current.x + dx, y: position.current.y + dy }); paint();
    }}
    onPointerUp={e => { e.stopPropagation(); finish(); }} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
    onKeyDown={e => { if (e.key === 'Escape' && mode.current === 'drag') { e.preventDefault(); e.stopPropagation(); finish(true); } }}
    onClick={e => {
      e.stopPropagation(); if (suppress.current) { suppress.current = false; return; }
      onClick?.(); stopReaction(); clearTimeout(clear.current);
      if (!deck.current.length) deck.current = reactionDeck(previousReaction.current);
      const index = deck.current.shift()!; previousReaction.current = index;
      const reaction = reactions[index]; reacting.current = true;
      setLine(t(`pets.reaction.${reaction.id}`)); setReactionGesture(reaction.gesture); setWalking(null); setAction(reaction.rows[0]);
      reaction.rows.slice(1).forEach((next, index) => reactionTimers.current.push(setTimeout(() => setAction(next), (index + 1) * 700)));
      reactionTimers.current.push(setTimeout(() => { stopReaction(); wake(); }, 2800));
    }}>
    <span className="pet-pose" data-gesture={reactionGesture ?? (walking !== null ? 'still' : pose.gesture)}>
      <PetSprite size={size} pet={pet} url={url} row={action ?? walking ?? cueRow} animate={animate} slow={slow} tempo={pose.tempo} delay={delay} />
      {carrying && <span className="pet-carried-card" data-tone={cardTone} aria-hidden="true" />}
    </span>
    {tag && <span className="pet-name">{tag}</span>}{line && <span className="pet-speech">{line}</span>}
  </button>;
}

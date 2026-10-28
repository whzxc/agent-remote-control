import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { t } from '../i18n';
import { scenarioName } from '../scenarioMode';
import { boundPet, type Point, type PetPackage } from './model';
import PetSprite from './PetSprite';
export interface PetActorHandle {
  place: (post: Point, bounds: Point & { top: number }, spawn?: Point) => void;
  cue: (row: number, speech?: string, carrying?: boolean) => void;
  point: () => Point | null;
  hide: () => void;
}
export default function PetActor({ pet, url, label, tag, animate, slow, row = 0, onClick, speak, cardTone, ref }: {
  pet: PetPackage; url: string; label: string; tag?: string; animate: boolean; slow: boolean; row?: number;
  cardTone?: 'neutral' | 'success' | 'danger'; onClick?: () => void; speak: () => boolean; ref: Ref<PetActorHandle>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const position = useRef<Point | null>(null), post = useRef<Point>({ x: 0, y: 0 }), bounds = useRef({ x: 0, y: 0, top: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const frame = useRef(0), release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mode = useRef<'post' | 'drag' | 'fall' | 'rest'>('post');
  const [action, setAction] = useState<number | null>(null), [line, setLine] = useState(''), [cueRow, setCueRow] = useState(row), [walking, setWalking] = useState<number | null>(null);
  const [carrying, setCarrying] = useState(!!cardTone);
  const lastFrame = useRef(0);
  const latest = useRef({ animate, row }); latest.current = { animate, row };
  const clear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const paint = () => { if (button.current && position.current) { button.current.style.transform = `translate(${position.current.x}px, ${position.current.y}px)`; button.current.style.visibility = 'visible'; button.current.style.display = ''; } };
  const clamp = (point: Point) => boundPet(point, bounds.current.x, bounds.current.y, bounds.current.top);
  const tick = (time: number) => {
    const elapsed = lastFrame.current ? Math.min(50, time - lastFrame.current) : 16; lastFrame.current = time;
    frame.current = 0;
    if (!position.current || !latest.current.animate || mode.current === 'drag' || mode.current === 'rest') return;
    const target = mode.current === 'fall' ? clamp({ x: position.current.x, y: position.current.y + 120 }) : clamp(post.current);
    const p = position.current, dx = target.x - p.x, dy = target.y - p.y;
    if (Math.hypot(dx, dy) < 1) {
      position.current = target; paint();
      if (mode.current === 'fall') {
        mode.current = 'rest'; setAction(4);
        release.current = setTimeout(() => { mode.current = 'post'; setAction(null); wake(); }, 1800);
      } else { setAction(null); setWalking(null); }
      return;
    }
    const step = 1 - Math.exp(-elapsed / (mode.current === 'fall' ? 80 : 140));
    if (mode.current === 'post') setWalking(dx >= 0 ? 1 : 2);
    position.current = { x: p.x + dx * step, y: p.y + dy * step }; paint();
    frame.current = requestAnimationFrame(tick);
  };
  const wake = () => { if (!frame.current && latest.current.animate) { lastFrame.current = 0; frame.current = requestAnimationFrame(tick); } };
  useImperativeHandle(ref, () => ({ place(target, size, spawn) {
    post.current = target; bounds.current = size;
    if (!position.current) {
      position.current = clamp(spawn ?? target);
      if (import.meta.env.DEV && scenarioName === 'pets-dragged' && !onClick) {
        position.current = clamp({ x: target.x + 100, y: target.y + 80 }); mode.current = 'rest'; setAction(6);
      }
    }
    if (!latest.current.animate && mode.current === 'post') position.current = clamp(target);
    else if (mode.current === 'post' && Math.hypot(position.current.x - target.x, position.current.y - target.y) > 2) wake();
    position.current = clamp(position.current); paint();
  }, cue(next, speech, carried) {
    setCueRow(next); if (carried !== undefined) setCarrying(carried);
    if (speech) { setLine(speech); clearTimeout(clear.current); clear.current = setTimeout(() => setLine(''), 2000); }
  }, point: () => button.current?.style.display === 'none' ? null : position.current && { x: position.current.x + 36, y: position.current.y + 39 },
    hide: () => { if (button.current) button.current.style.display = 'none'; cancelAnimationFrame(frame.current); frame.current = 0; } }));
  useEffect(() => {
    if (animate) wake(); else { cancelAnimationFrame(frame.current); frame.current = 0; if (mode.current !== 'drag') { mode.current = 'post'; position.current = clamp(post.current); setAction(null); paint(); } }
  }, [animate]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); clearTimeout(release.current); clearTimeout(clear.current); }, []);
  function finish(cancel = false) {
    const d = drag.current; if (!d) return;
    drag.current = null; if (button.current) delete button.current.dataset.dangling;
    if (button.current?.hasPointerCapture(d.pointer)) button.current.releasePointerCapture(d.pointer);
    if (!d.moved || cancel || !animate) { mode.current = 'post'; setAction(null); wake(); }
    else { mode.current = 'fall'; setAction(4); wake(); }
  }
  const suppress = useRef(false);
  return <button ref={button} type="button" className="topology-pet" data-motion={animate || undefined} aria-label={label}
    onPointerDown={e => {
      if (e.button !== 0 || !e.isPrimary) return;
      e.stopPropagation(); clearTimeout(release.current); cancelAnimationFrame(frame.current); frame.current = 0;
      drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false }; suppress.current = false;
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
    onKeyDown={e => { if (e.key === 'Escape' && drag.current) { e.preventDefault(); e.stopPropagation(); finish(true); } }}
    onClick={e => {
      e.stopPropagation(); if (suppress.current) { suppress.current = false; return; }
      onClick?.(); setAction(3); if (speak()) setLine(t('pets.hello'));
      clearTimeout(clear.current); clear.current = setTimeout(() => { setAction(null); setLine(''); }, 1800);
    }}>
    <PetSprite pet={pet} url={url} row={action ?? walking ?? cueRow} animate={animate} slow={slow} />
    {carrying && <span className="pet-carried-card" data-tone={cardTone} aria-hidden="true" />}
    {tag && <span className="pet-name">{tag}</span>}{line && <span className="pet-speech">{line}</span>}
  </button>;
}

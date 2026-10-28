import { useEffect, useRef, useState } from 'react';
import { usePetMotion } from '../pets/usePetMotion';
import { panelLayers } from '../state/panels';

// Share the existing event-driven native visibility and reduced-motion policy.
export function useStudioMotion(enabled: boolean) {
  const motion = usePetMotion(), layers = panelLayers.use();
  const [idle, setIdle] = useState(false);
  const hovering = useRef(false);
  useEffect(() => {
    if (!enabled || !motion.animate) { hovering.current = false; setIdle(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    const controls = 'button, a, input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [data-panel-anchor]';
    const hoverSelector = controls.split(',').map(selector => `${selector.trim()}:hover`).join(',');
    hovering.current = !!document.querySelector(hoverSelector);
    const onControl = (target: EventTarget | null) => target instanceof Element && !!target.closest(controls);
    const focusOwnsAttention = () => document.activeElement instanceof Element &&
      (document.activeElement.matches('input, textarea, select, [contenteditable="true"]') || document.activeElement.matches(':focus-visible') && onControl(document.activeElement));
    const settle = () => {
      clearTimeout(timer); setIdle(false);
      timer = setTimeout(() => {
        // A removed popup does not always dispatch pointerout to its old control.
        hovering.current = !!document.querySelector(hoverSelector);
        if (!hovering.current && !focusOwnsAttention() && !panelLayers.get().length &&
          !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')) setIdle(true);
      }, 2400);
    };
    const over = (event: PointerEvent) => { const next = onControl(event.target); if (next !== hovering.current) { hovering.current = next; settle(); } };
    const out = (event: PointerEvent) => { const next = onControl(event.relatedTarget); if (next !== hovering.current) { hovering.current = next; settle(); } };
    const leave = () => { hovering.current = false; settle(); };
    document.addEventListener('pointerover', over, { passive: true });
    document.addEventListener('pointerout', out, { passive: true });
    document.addEventListener('pointerleave', leave, { passive: true });
    document.addEventListener('pointerdown', settle, { passive: true });
    document.addEventListener('keydown', settle);
    document.addEventListener('wheel', settle, { passive: true });
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    settle();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out); document.removeEventListener('pointerleave', leave);
      document.removeEventListener('pointerdown', settle); document.removeEventListener('keydown', settle); document.removeEventListener('wheel', settle);
      document.removeEventListener('focusin', settle); document.removeEventListener('focusout', settle);
    };
  }, [enabled, motion.animate, layers.length]);
  return { visible: motion.visible, state: !enabled || !motion.animate ? 'off' : !idle || layers.length ? 'quiet' : 'active' } as const;
}

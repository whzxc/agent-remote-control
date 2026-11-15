import { useContext, useRef, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ViewContext } from '../ui/LayerPortals';
export function DialogView({ open, title, onBack, children, footer }: {
  open: boolean; title: string; onBack: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const context = useContext(ViewContext);
  const back = useRef(onBack); back.current = onBack;
  useLayoutEffect(() => {
    if (!open || !context) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    context.set({ title, back: () => back.current(), trigger });
    return () => context.set(null);
  }, [open, title, context?.set]);
  useLayoutEffect(() => {
    if (!open || !context?.body) return;
    const frame = requestAnimationFrame(() => context.body?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, context?.body]);
  return context && <>{context.body && createPortal(children, context.body)}{context.footer && createPortal(footer, context.footer)}</>;
}

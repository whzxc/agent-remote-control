import { useId, useLayoutEffect, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { surfaceMotion, type Surface, type SurfaceRect } from '../motion/surface';
import { consumeOutsidePointer, layers, layerTrigger } from '../state/layers';

const frameAt = (rect: SurfaceRect): Surface => ({
  transform: `translate(calc(-50% + ${rect.x + rect.width / 2 - innerWidth / 2}px),calc(-50% + ${rect.y + rect.height / 2 - innerHeight / 2}px))`,
  width: `${rect.width}px`, height: `${rect.height}px`, opacity: 1, borderRadius: 'var(--radius-panel)',
});

/** Node dock only. Workspace and dialog placement have separate owners. */
export default function ElasticPanel({ onClose, onCloseStart, title, labelledBy, children, busy = false, className = '', width = 400,
  dock, dockRect, dockAnchorY, expanded = false, fitDockHeight = false, closeRequested = false,
  originKey, returnFocus, onPanelFrame }: {
  onClose: () => void | Promise<void>; onCloseStart?: () => void; title: ReactNode; labelledBy?: string; children: ReactNode;
  busy?: boolean; className?: string; width?: number; dock: 'left' | 'right'; dockRect?: SurfaceRect; dockAnchorY?: number;
  expanded?: boolean; contentFit?: boolean; fitDockHeight?: boolean; closeRequested?: boolean; originKey?: string;
  returnFocus?: string; onPanelFrame?: (rect: SurfaceRect | null) => void; headerless?: boolean;
}) {
  const id = useId(), snapshot = layers.use();
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null), closing = useRef(false);
  const geometryKey = JSON.stringify([dockRect, dockAnchorY, width, expanded, fitDockHeight, originKey]);
  const previousGeometry = useRef(geometryKey);
  const motion = useRef<ReturnType<typeof surfaceMotion> | null>(null);
  const latest = useRef({ onClose, onCloseStart, busy, onPanelFrame });
  latest.current = { onClose, onCloseStart, busy, onPanelFrame };
  const target = useRef({ dockRect, dockAnchorY, fitDockHeight, width, expanded, dock });
  target.current = { dockRect, dockAnchorY, fitDockHeight, width, expanded, dock };
  const resting = () => {
    const value = target.current;
    if (value.dockRect && !value.fitDockHeight) return frameAt(value.dockRect);
    const panelWidth = Math.min(value.expanded ? innerWidth - 32 : value.width, innerWidth - 32);
    const x = value.expanded ? 0 : (value.dock === 'left' ? -1 : 1) * ((innerWidth - panelWidth) / 2 - 16);
    const anchor = value.dockAnchorY;
    if (value.fitDockHeight && anchor !== undefined) {
      const top = value.dockRect?.y ?? 16, bottom = value.dockRect ? value.dockRect.y + value.dockRect.height : innerHeight - 16;
      return { transform: `translate(calc(-50% + ${x}px),clamp(${top - innerHeight / 2}px,calc(${anchor - innerHeight / 2}px - 50%),calc(${bottom - innerHeight / 2}px - 100%)))`, width: '', height: '' };
    }
    return { transform: `translate(calc(-50% + ${x}px),-50%)`, width: '', height: '' };
  };
  const close = async () => {
    if (closing.current || latest.current.busy) return;
    closing.current = true;
    latest.current.onCloseStart?.();
    try {
      const destination = trigger.current?.getBoundingClientRect();
      if (destination?.width && motion.current) await motion.current.to(
        { ...frameAt(destination), borderRadius: '50%' }, { duration: 0.16, retain: true });
      await latest.current.onClose();
    } finally { closing.current = false; }
  };
  useLayoutEffect(() => {
    if (!node) return;
    trigger.current = layerTrigger()?.element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.open({ id, node, kind: 'panel', trigger: trigger.current, returnFocus, onClose: close });
    const surface = surfaceMotion(node, resting, rect => latest.current.onPanelFrame?.(rect), false, () => target.current.fitDockHeight);
    motion.current = surface;
    const origin = layerTrigger()?.rect;
    if (origin?.width) void surface.to(frameAt(node.getBoundingClientRect()), {
      from: { ...frameAt(origin), borderRadius: '50%' }, duration: 0.25,
    });
    const observer = new ResizeObserver(() => { if (!surface.running) latest.current.onPanelFrame?.(node.getBoundingClientRect()); });
    observer.observe(node);
    latest.current.onPanelFrame?.(node.getBoundingClientRect());
    const resize = () => { if (!surface.running) Object.assign(node.style, resting()); };
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', resize); surface.dispose(); motion.current = null;
      latest.current.onPanelFrame?.(null); layers.remove(id);
    };
  }, [node, id, returnFocus]);
  useLayoutEffect(() => {
    trigger.current = layerTrigger()?.element ?? trigger.current;
    if (!node || !motion.current || previousGeometry.current === geometryKey) return;
    previousGeometry.current = geometryKey;
    void motion.current.to(resting(), { duration: 0.18 });
  }, [node, geometryKey]);
  useEffect(() => { if (closeRequested && !busy) void close(); }, [closeRequested, busy]);
  const recessed = !!node && snapshot.at(-1)?.node !== node;
  return <D.Root modal={false} open onOpenChange={next => { if (!next) void close(); }}><D.Portal>
    <D.Content ref={setNode} className={`dialog elastic-panel activity-panel headerless ${className}`} data-panel-dock={dock}
      data-panel-geometry={dockRect ? 'portrait' : undefined} data-panel-fit={fitDockHeight || undefined}
      data-panel-depth="1" inert={recessed || undefined} aria-describedby={undefined} {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      style={{ '--preferred-width': expanded ? 'calc(100vw - 32px)' : `${width}px`, ...resting(),
        ...(dockRect ? { '--panel-layout-width': `${dockRect.width}px`, '--panel-layout-height': `${dockRect.height}px`, maxHeight: dockRect.height } : {}),
        zIndex: 102 } as CSSProperties}
      onOpenAutoFocus={event => { event.preventDefault(); node?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => { event.preventDefault(); layers.restoreFocus({ trigger: trigger.current, returnFocus }); }}
      onEscapeKeyDown={event => { event.preventDefault(); layers.dismiss(id); }}
      onPointerDownOutside={event => {
        event.preventDefault();
        if (event.detail.originalEvent.button !== 0 || layers.top()?.id !== id) return;
        const target = event.detail.originalEvent.target;
        if (target instanceof Element && target.closest('.graph-node, .hub-entry')) return;
        consumeOutsidePointer(event.detail.originalEvent); layers.dismiss(id);
      }} onInteractOutside={event => event.preventDefault()}>
      <div className="elastic-panel-content"><D.Title className="sr-only">{title}</D.Title>
        <div className="dialog-body">{children}</div></div>
    </D.Content>
  </D.Portal></D.Root>;
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { animate, type AnimationPlaybackControlsWithThen } from "motion";
import { surfaceMotion, reducedMotion as reduced, type Surface, type SurfaceRect } from "../motion/surface";
import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { t } from "../i18n";
import {
  panelLayers,
  panelAnchorAt,
} from "../state/panels";
import {
  takePanelOrigin, readOrigin, hideOrigin, animateOriginContent, surfaceOf,
  type PanelOrigin,
} from "./panelMorph";
const frameAt = (rect: SurfaceRect, opacity: number, borderRadius: string): Surface => ({
  transform: `translate(calc(-50% + ${rect.x + rect.width / 2 - innerWidth / 2}px),calc(-50% + ${rect.y + rect.height / 2 - innerHeight / 2}px))`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
  opacity,
  borderRadius,
});
export default function ElasticPanel({
  open = true,
  onClose,
  onCloseStart,
  onDismiss,
  onEscapeKeyDown,
  title,
  labelledBy,
  children,
  footer,
  actions,
  leading,
  headerDetail,
  centered = false,
  sheet = false,
  stepBar,
  wide = false,
  busy = false,
  unframed = false,
  headerless = false,
  width,
  depthOffset = 0,
  initialFocus,
  dock,
  dockRect,
  expanded = false,
  closeRequested = false,
  originKey,
  returnFocus,
  onMotion,
  onPanelFrame,
}: {
  open?: boolean;
  onClose: () => void | Promise<void>;
  onCloseStart?: () => void;
  onDismiss?: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  title: ReactNode;
  labelledBy?: string;
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  headerDetail?: ReactNode;
  centered?: boolean;
  sheet?: boolean;
  stepBar?: ReactNode;
  wide?: boolean;
  busy?: boolean;
  unframed?: boolean;
  headerless?: boolean;
  width?: number;
  depthOffset?: number;
  initialFocus?: string;
  dock?: "left" | "right";
  dockRect?: SurfaceRect;
  expanded?: boolean;
  closeRequested?: boolean;
  originKey?: string;
  returnFocus?: string;
  onMotion?: () => void;
  onPanelFrame?: (rect: SurfaceRect | null) => void;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null),
    [position, setPosition] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    setNode(el);
  }, []);
  const dockPosition = () => dockRect ? { x: dockRect.x + dockRect.width / 2 - innerWidth / 2, y: dockRect.y + dockRect.height / 2 - innerHeight / 2 } : ({ x: expanded ? 0 : (dock === "left" ? -1 : 1) * ((innerWidth - Math.min(width ?? 400, innerWidth - 32)) / 2 - 16), y: 0 });
  const positionRef = useRef(position);
  positionRef.current = dock ? dockPosition() : position;
  const dockRectRef = useRef(dockRect); dockRectRef.current = dockRect;
  const previousDockRect = useRef(dockRect);
  const visualOrigin = useRef<PanelOrigin | undefined>(undefined);
  const restoreOrigin = useRef<(() => void) | undefined>(undefined);
  const clearGhost = useRef<(() => void) | undefined>(undefined);
  const trigger = useRef<HTMLElement | null>(null);
  const origin = useRef<DOMRect | undefined>(undefined);
  const parentPanel = useRef<HTMLElement | undefined>(undefined);
  const [baseDepth, setBaseDepth] = useState(1);
  const [sheetFrame, setSheetFrame] = useState({ left: innerWidth / 2, bottom: 8, height: innerHeight, width: Math.min(width ?? 360, innerWidth - 16) });
  useLayoutEffect(() => {
    if (!sheet || !open || !node) return;
    const host = trigger.current?.closest<HTMLElement>("[data-panel-dock]");
    const measure = () => {
      const rect = host?.getBoundingClientRect();
      setSheetFrame({ left: rect ? rect.left + rect.width / 2 : innerWidth / 2,
        bottom: rect ? Math.max(8, innerHeight - rect.bottom + 8) : 8,
        height: rect?.height ?? innerHeight, width: Math.min(width ?? 360, (rect?.width ?? innerWidth) - 16) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (host) observer.observe(host);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [sheet, open, node, width]);
  const closing = useRef(false),
    motion = useRef<ReturnType<typeof surfaceMotion> | null>(null),
    backdropPressed = useRef(false);
  const drag = useRef<
    { id: number; x: number; y: number; left: number; top: number } | undefined
  >(undefined);
  const layers = panelLayers.use(),
    recessed = !!node && layers.includes(node) && layers.at(-1) !== node;
  const previousExpanded = useRef(expanded), previousWidth = useRef(width), dockFrame = useRef<SurfaceRect | null>(null);
  const latest = useRef({ onClose, onCloseStart, onDismiss, busy, depthOffset });
  latest.current = { onClose, onCloseStart, onDismiss, busy, depthOffset };
  const moveTo = (x: number, y: number) => {
    if (!node) return;
    if (dock) { setPosition(dockPosition()); return; }
    const maxX = Math.max(0, (innerWidth - node.offsetWidth) / 2 - 20),
      maxY = Math.max(0, (innerHeight - node.offsetHeight) / 2 - 20);
    setPosition({
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const savedOrigin = takePanelOrigin();
    const visual = savedOrigin ?? (
      active instanceof HTMLElement && active.matches("button, [data-panel-anchor]")
        ? readOrigin(active) : undefined
    );
    visualOrigin.current = visual;
    trigger.current = savedOrigin?.trigger ?? visual?.trigger ?? (active instanceof HTMLElement ? active : null);
    origin.current = visual?.rect;
    parentPanel.current = dock ? undefined : visual?.parent;
    closing.current = false;
    setPosition(dock ? dockPosition() : { x: 0, y: 0 });
  }, [open]);
  useLayoutEffect(() => {
    if (!node || !open) return;
    const previous = panelLayers.get().filter(panel => panel.isConnected && panel !== node && !panel.dataset.panelDock).at(-1);
    const parent = dock ? undefined : parentPanel.current?.isConnected ? parentPanel.current : previous;
    parentPanel.current = parent;
    setBaseDepth(parent ? Number(parent.dataset.panelDepth || 1) + 1 : 1);
    const source = parent?.getBoundingClientRect() ?? visualOrigin.current?.rect ?? origin.current;
    panelLayers.set((old) => [...old, node]);
    const focusFrame = requestAnimationFrame(() =>
      (initialFocus ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node : node).focus({ preventScroll: true }),
    );
    let rect = node.getBoundingClientRect();
    if (parent && source && !centered && !sheet) {
      const x = Math.max(-(innerWidth - rect.width) / 2 + 20, Math.min((innerWidth - rect.width) / 2 - 20, source.x + source.width / 2 - innerWidth / 2));
      const y = Math.max(-(innerHeight - rect.height) / 2 + 20, Math.min((innerHeight - rect.height) / 2 - 20, source.y + source.height / 2 - innerHeight / 2));
      setPosition({ x, y });
      rect = new DOMRect((innerWidth - rect.width) / 2 + x, (innerHeight - rect.height) / 2 + y, rect.width, rect.height);
    }
    const surface = surfaceMotion(node, () => dockRectRef.current ? frameAt(dockRectRef.current, 1, "20px") : ({
      // A shell first opened in portrait must release its explicit size when
      // returning to the landscape dock's CSS-owned viewport height.
      ...(dock ? { width: "", height: "" } : {}),
      transform: sheet ? "translateX(-50%)" : `translate(calc(-50% + ${positionRef.current.x}px),calc(-50% + ${positionRef.current.y}px))`,
    }), frame => { dockFrame.current = frame; onMotion?.(); onPanelFrame?.(frame); }, !dock && !sheet);
    dockFrame.current = rect;
    onPanelFrame?.(rect);
    motion.current = surface;
    const fades: AnimationPlaybackControlsWithThen[] = [];
    const morphOrigin = !sheet && !!visualOrigin.current && (centered || !!visualOrigin.current.trigger.closest(".graph-node, .hub-entry, [data-timeline-anchor]"));
    if (!reduced() && source && rect.width && !parent && morphOrigin) {
      const visual = visualOrigin.current;
      void surface.to({ ...frameAt(rect, 1, getComputedStyle(node).borderRadius), ...surfaceOf(node) }, {
        from: { ...frameAt(source, visual ? 1 : 0, "28px"), ...(visual?.surface ?? {}) },
        duration: dock ? 0.25 : undefined,
      });
      if (visual) {
        if (dock) {
          // Keep the real moving node above the expanding shell, without
          // replacing it with a stationary copy or changing its opacity.
          const anchor = visual.trigger.closest<HTMLElement>(".topology-node");
          if (anchor) {
            const before = anchor.style.zIndex;
            anchor.style.zIndex = String(Number(node.style.zIndex) + 1);
            restoreOrigin.current = () => { anchor.style.zIndex = before; };
          }
        } else {
          restoreOrigin.current = hideOrigin(visual);
          clearGhost.current = animateOriginContent(visual, Number(node.style.zIndex) + 1);
        }
      }
      for (const child of Array.from(node.children))
        fades.push(animate(child, { opacity: [0, 1] }, { duration: 0.15 }));
    }
    if (!reduced() && (parent || !morphOrigin))
      fades.push(animate(node.firstElementChild!, { opacity: [0, 1] }, { duration: 0.16 }));
    return () => {
      cancelAnimationFrame(focusFrame);
      restoreOrigin.current?.();
      clearGhost.current?.();
      panelLayers.set((old) => old.filter((el) => el !== node));
      fades.forEach((fade) => fade.stop());
      surface.dispose();
      onPanelFrame?.(null);
      motion.current = null;
    };
  }, [node, open]);
  useEffect(() => {
    const resize = () => moveTo(positionRef.current.x, positionRef.current.y);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [node, expanded, width]);
  useLayoutEffect(() => {
    if (!node || !dock) return;
    const rect = node.getBoundingClientRect(), from = dockFrame.current;
    if (previousExpanded.current !== expanded || previousWidth.current !== width || JSON.stringify(previousDockRect.current) !== JSON.stringify(dockRect)) {
      previousExpanded.current = expanded;
      previousWidth.current = width;
      previousDockRect.current = dockRect;
      if (from && motion.current && !closing.current) {
        const panelWidth = Math.min(expanded ? innerWidth - 32 : width ?? 400, innerWidth - 32);
        const target = dockRect ?? { x: dock === "left" ? 16 : innerWidth - panelWidth - 16, y: 16, width: panelWidth, height: innerHeight - 32 };
        void motion.current.to(frameAt(target, 1, "20px"), { from: frameAt(from, 1, "20px"), duration: 0.18 });
        return;
      }
    }
    if (!motion.current?.running) { dockFrame.current = rect; onPanelFrame?.(rect); }
  }, [node, position, dock, dockRect, expanded, width, onPanelFrame]);
  async function close(replacement?: HTMLElement, dismiss = false) {
    if (latest.current.busy || closing.current || !node) return;
    if (latest.current.depthOffset > 0 && !dismiss) {
      latest.current.onClose();
      return;
    }
    closing.current = true;
    const closingView = latest.current;
    closingView.onCloseStart?.();
    if (!dock) restoreOrigin.current?.();
    const parent = parentPanel.current?.isConnected ? parentPanel.current : undefined;
    if (parent) replacement = undefined;
    const saved = visualOrigin.current;
    const visual = !parent && saved?.visual.isConnected
      ? readOrigin(saved.trigger, saved.visual)
      : undefined;
    clearGhost.current?.();
    const from = node.getBoundingClientRect(),
      to = parent?.getBoundingClientRect() ?? visual?.rect ?? origin.current;
    if (!sheet && !replacement && to && !parent && visual && (centered || visual.trigger.closest(".graph-node, .hub-entry, [data-timeline-anchor]")) && !reduced()) {
      const style = getComputedStyle(node);
      const current = { ...frameAt(from, Number(style.opacity), style.borderRadius), ...surfaceOf(node) };
      const destination = dock ? () => ({ ...frameAt(visual.visual.isConnected ? visual.visual.getBoundingClientRect() : to, 1, "50%"), ...visual.surface })
        : { ...frameAt(to, 1, "50%"), ...visual.surface };
      const animation = motion.current?.to(
        destination,
        { retain: true, duration: dock ? 0.16 : undefined, ...(motion.current.running ? {} : { from: current }) },
      );
      if (!dock) {
        restoreOrigin.current = hideOrigin(visual);
        clearGhost.current = animateOriginContent(visual, Number(node.style.zIndex) + 1, true);
      }
      Array.from(node.children).forEach((child) => {
        animate(child, { opacity: 0 }, { duration: 0.15 });
      });
      await animation;

    }
    if (parent && !reduced()) await animate(node.firstElementChild!, { opacity: 0 }, { duration: 0.14 });
    try {
      await (dismiss ? closingView.onDismiss ?? closingView.onClose : closingView.onClose)();
    } finally {
      closing.current = false;
      // Let React remove the closed child before restoring a dialog retained
      // after an operation error. Restoring it immediately flashes the child.
      if (parent) requestAnimationFrame(() => {
        if (node.isConnected && node.firstElementChild) (node.firstElementChild as HTMLElement).style.opacity = "1";
      });
    }
    if (replacement)
      requestAnimationFrame(() => {
        replacement.focus({ preventScroll: true });
        replacement.click();
      });
  }
  useEffect(() => { if (closeRequested) void close(undefined, true); }, [closeRequested, busy]);
  const previousOrigin = useRef(originKey);
  useLayoutEffect(() => {
    if (previousOrigin.current === originKey) return;
    previousOrigin.current = originKey;
    restoreOrigin.current?.();
    const visual = takePanelOrigin();
    visualOrigin.current = visual;
    trigger.current = visual?.trigger ?? null;
    origin.current = visual?.rect;
  }, [originKey]);
  return (
    <D.Root
      modal={!dock}
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      <D.Portal>
        {!dock && <D.Overlay
          className="elastic-backdrop"
          style={{ zIndex: 100 + Math.max(0, layers.indexOf(node!)) * 2 }}
          onPointerDown={(e) => {
            backdropPressed.current =
              e.button === 0 && e.target === e.currentTarget;
          }}
          onPointerCancel={() => (backdropPressed.current = false)}
          onClick={(e) => {
            if (backdropPressed.current && e.target === e.currentTarget) {
              backdropPressed.current = false;
              void close(
                panelAnchorAt(
                  e.clientX,
                  e.clientY,
                  trigger.current ?? undefined,
                ),
              );
            }
          }}
        />}
        <D.Content
          ref={attach}
          className={`dialog elastic-panel ${wide ? "dialog-wide" : ""} ${unframed ? "unframed" : ""} ${headerless ? "headerless" : ""} ${dock ? "activity-panel" : ""} ${centered ? "setup-dialog" : ""}`}
          data-panel-dock={dock}
          data-panel-geometry={dockRect ? "portrait" : undefined}
          data-sheet={sheet || undefined}
          data-recessed={recessed || undefined}
          inert={recessed || undefined}
          data-panel-depth={baseDepth + depthOffset}
          aria-describedby={undefined}
          {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
          style={
            {
              ...(sheet ? { top: "auto", left: sheetFrame.left, bottom: sheetFrame.bottom, width: sheetFrame.width, "--sheet-host-height": `${sheetFrame.height}px` } : {}),
              "--preferred-width": dock && expanded ? "calc(100vw - 32px)" : `${width ?? (wide ? 880 : 800)}px`,
              transform: sheet ? "translateX(-50%)" : `translate(calc(-50% + ${positionRef.current.x}px),calc(-50% + ${positionRef.current.y}px))`,
              ...(dockRect ? { ...frameAt(dockRect, 1, '20px'), '--panel-layout-width': `${dockRect.width}px`, '--panel-layout-height': `${dockRect.height}px`, maxHeight: dockRect.height } : {}),
              zIndex: (dock ? 102 : 101) + Math.max(0, layers.indexOf(node!)) * 2,
            } as CSSProperties
          }
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const target = initialFocus ? panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) : panelRef.current;
            (target ?? panelRef.current)?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Wait for the scene to restore its bubbles and remove modal inert.
            requestAnimationFrame(() => {
              if (dock && document.querySelector("[data-panel-dock]")) return;
              const focused = document.activeElement;
              // Successor dialogs include portaled popovers outside panelLayers.
              const focusedOwner = focused?.closest('[role="dialog"]');
              if (focusedOwner && focused !== focusedOwner && focusedOwner !== node) return;
              const fallbacks = returnFocus ? Array.from(document.querySelectorAll<HTMLElement>(returnFocus)) : [];
              for (const target of [trigger.current, parentPanel.current, panelLayers.get().at(-1), ...fallbacks]) {
                if (!target?.isConnected || target === document.body || target.closest("[inert], [hidden]") || target.matches(":disabled")) continue;
                const style = getComputedStyle(target);
                if (style.display === "none" || style.visibility === "hidden") continue;
                target.focus({ preventScroll: true });
                if (document.activeElement === target) break;
              }
            });
          }}
          onEscapeKeyDown={(e) => {
            onEscapeKeyDown?.(e);
            if (e.defaultPrevented) return;
            e.preventDefault();
            void close();
          }}
          onPointerDownOutside={(e) => {
            if (!dock || panelLayers.get().at(-1) !== node || e.detail.originalEvent.button !== 0) return;
            const target = e.detail.originalEvent.target;
            if (target instanceof Element && target.closest(".graph-node, .hub-entry")) return;
            void close(undefined, true);
          }}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="elastic-panel-content">
            {unframed || headerless ? (
              <D.Title className="sr-only">{title}</D.Title>
            ) : (
              <header
                className="dialog-header"
                data-leading={leading ? "true" : "false"}
                onPointerDown={(e) => {
                  if (
                    centered || sheet || dock || e.button !== 0 ||
                    !e.isPrimary ||
                    (e.target as Element).closest("button") ||
                    motion.current?.running
                  )
                    return;
                  drag.current = {
                    id: e.pointerId,
                    x: e.clientX,
                    y: e.clientY,
                    left: position.x,
                    top: position.y,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  e.preventDefault();
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d && d.id === e.pointerId)
                    moveTo(d.left + e.clientX - d.x, d.top + e.clientY - d.y);
                }}
                onPointerUp={(e) => {
                  drag.current = undefined;
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={() => (drag.current = undefined)}
              >
                {leading}
                <D.Title>{title}</D.Title>
                <div className="actions">
                  {actions}
                  <button
                    type="button"
                    className="button ghost icon-button"
                    aria-label={t("close")}
                    disabled={busy}
                    onClick={() => void close(undefined, true)}
                  >
                    <X size={20} strokeWidth={1.75} />
                  </button>
                </div>
                {headerDetail}
              </header>
            )}
            {stepBar}
            <div className="dialog-body">{children}</div>
            {footer && <footer className="dialog-footer">{footer}</footer>}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

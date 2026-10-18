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
import { surfaceMotion, reducedMotion as reduced, type Surface } from "../motion/surface";
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
const frameAt = (rect: DOMRect, opacity: number, borderRadius: string): Surface => ({
  transform: `translate(calc(-50% + ${rect.x + rect.width / 2 - innerWidth / 2}px),calc(-50% + ${rect.y + rect.height / 2 - innerHeight / 2}px))`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
  opacity,
  borderRadius,
});
export default function ElasticPanel({
  open = true,
  onClose,
  onDismiss,
  title,
  children,
  footer,
  actions,
  leading,
  wide = false,
  busy = false,
  unframed = false,
  headerless = false,
  width,
  depthOffset = 0,
  initialFocus,
}: {
  open?: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  wide?: boolean;
  busy?: boolean;
  unframed?: boolean;
  headerless?: boolean;
  width?: number;
  depthOffset?: number;
  initialFocus?: string;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null),
    [position, setPosition] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    setNode(el);
  }, []);
  const positionRef = useRef(position);
  positionRef.current = position;
  const visualOrigin = useRef<PanelOrigin | undefined>(undefined);
  const restoreOrigin = useRef<(() => void) | undefined>(undefined);
  const clearGhost = useRef<(() => void) | undefined>(undefined);
  const trigger = useRef<HTMLElement | null>(null);
  const origin = useRef<DOMRect | undefined>(undefined);
  const parentPanel = useRef<HTMLElement | undefined>(undefined);
  const [baseDepth, setBaseDepth] = useState(1);
  const closing = useRef(false),
    motion = useRef<ReturnType<typeof surfaceMotion> | null>(null),
    backdropPressed = useRef(false);
  const drag = useRef<
    { id: number; x: number; y: number; left: number; top: number } | undefined
  >(undefined);
  const layers = panelLayers.use(),
    recessed = !!node && layers.includes(node) && layers.at(-1) !== node;
  const previousView = useRef({ recessed, depthOffset });
  const latest = useRef({ onClose, onDismiss, busy, depthOffset });
  latest.current = { onClose, onDismiss, busy, depthOffset };
  const moveTo = (x: number, y: number) => {
    if (!node) return;
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
    const visual = takePanelOrigin() ?? (
      active instanceof HTMLElement && active.matches("button, [data-panel-anchor]")
        ? readOrigin(active) : undefined
    );
    visualOrigin.current = visual;
    trigger.current = visual?.trigger ?? null;
    origin.current = visual?.rect;
    parentPanel.current = visual?.parent;
    closing.current = false;
    setPosition({ x: 0, y: 0 });
  }, [open]);
  useLayoutEffect(() => {
    if (!node || !open) return;
    const previous = panelLayers.get().filter(panel => panel.isConnected && panel !== node).at(-1);
    const parent = parentPanel.current?.isConnected ? parentPanel.current : previous;
    parentPanel.current = parent;
    setBaseDepth(parent ? Number(parent.dataset.panelDepth || 1) + 1 : 1);
    const source = parent?.getBoundingClientRect() ?? visualOrigin.current?.rect ?? origin.current;
    panelLayers.set((old) => [...old, node]);
    const focusFrame = requestAnimationFrame(() =>
      (initialFocus ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node : node).focus({ preventScroll: true }),
    );
    let rect = node.getBoundingClientRect();
    if (parent && source) {
      const x = Math.max(-(innerWidth - rect.width) / 2 + 20, Math.min((innerWidth - rect.width) / 2 - 20, source.x + source.width / 2 - innerWidth / 2));
      const y = Math.max(-(innerHeight - rect.height) / 2 + 20, Math.min((innerHeight - rect.height) / 2 - 20, source.y + source.height / 2 - innerHeight / 2));
      setPosition({ x, y });
      rect = new DOMRect((innerWidth - rect.width) / 2 + x, (innerHeight - rect.height) / 2 + y, rect.width, rect.height);
    }
    const surface = surfaceMotion(node, () => ({
      transform: `translate(calc(-50% + ${positionRef.current.x}px),calc(-50% + ${positionRef.current.y}px))`,
    }));
    motion.current = surface;
    const fades: AnimationPlaybackControlsWithThen[] = [];
    if (!reduced() && source && rect.width && !parent && visualOrigin.current?.trigger.closest(".graph-node")) {
      const visual = visualOrigin.current;
      surface.to({ ...frameAt(rect, 1, "28px"), ...surfaceOf(node) }, {
        from: { ...frameAt(source, visual ? 1 : 0, "28px"), ...(visual?.surface ?? {}) },
      });
      if (visual) {
        restoreOrigin.current = hideOrigin(visual);
        clearGhost.current = animateOriginContent(visual, Number(node.style.zIndex) + 1);
      }
      for (const child of Array.from(node.children))
        fades.push(animate(child, { opacity: [0, 1] }, { duration: 0.15 }));
    }
    if (!reduced() && (parent || !visualOrigin.current?.trigger.closest(".graph-node")))
      fades.push(animate(node.firstElementChild!, { opacity: [0, 1] }, { duration: 0.16 }));
    return () => {
      cancelAnimationFrame(focusFrame);
      restoreOrigin.current?.();
      clearGhost.current?.();
      panelLayers.set((old) => old.filter((el) => el !== node));
      fades.forEach((fade) => fade.stop());
      surface.dispose();
      motion.current = null;
    };
  }, [node, open]);
  useEffect(() => {
    const resize = () => moveTo(positionRef.current.x, positionRef.current.y);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [node]);
  useLayoutEffect(() => {
    const returned = previousView.current.recessed && !recessed;
    const stepped = previousView.current.depthOffset !== depthOffset;
    previousView.current = { recessed, depthOffset };
    if (node && !recessed && (returned || stepped) && !reduced()) {
      const content = node.firstElementChild;
      const animation = content ? animate(content, { opacity: [0, 1] }, { duration: 0.18 }) : undefined;
      return () => { animation?.stop(); };
    }
  }, [node, recessed, depthOffset]);
  async function close(replacement?: HTMLElement, dismiss = false) {
    if (latest.current.busy || closing.current || !node) return;
    if (latest.current.depthOffset > 0 && !dismiss) {
      latest.current.onClose();
      return;
    }
    closing.current = true;
    restoreOrigin.current?.();
    const parent = parentPanel.current?.isConnected ? parentPanel.current : undefined;
    if (parent) replacement = undefined;
    const saved = visualOrigin.current;
    const visual = !parent && saved?.visual.isConnected
      ? readOrigin(saved.trigger, saved.visual)
      : undefined;
    clearGhost.current?.();
    const from = node.getBoundingClientRect(),
      to = parent?.getBoundingClientRect() ?? visual?.rect ?? origin.current;
    if (!replacement && to && !parent && visual?.trigger.closest(".graph-node") && !reduced()) {
      const style = getComputedStyle(node);
      const current = { ...frameAt(from, Number(style.opacity), style.borderRadius), ...surfaceOf(node) };
      const animation = motion.current?.to(
        { ...frameAt(to, visual || parent ? 1 : 0, parent ? "28px" : "50%"), ...(visual?.surface ?? {}) },
        { retain: true, ...(motion.current.running ? {} : { from: current }) },
      );
      if (visual) {
        restoreOrigin.current = hideOrigin(visual);
        clearGhost.current = animateOriginContent(visual, Number(node.style.zIndex) + 1, true);
      }
      Array.from(node.children).forEach((child) => {
        animate(child, { opacity: 0 }, { duration: 0.15 });
      });
      await animation;

    }
    if (parent && !reduced()) await animate(node.firstElementChild!, { opacity: 0 }, { duration: 0.14 });
    (dismiss ? latest.current.onDismiss ?? latest.current.onClose : latest.current.onClose)();
    if (replacement)
      requestAnimationFrame(() => {
        replacement.focus({ preventScroll: true });
        replacement.click();
      });
  }
  return (
    <D.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      <D.Portal>
        <D.Overlay
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
        />
        <D.Content
          ref={attach}
          className={`dialog elastic-panel ${wide ? "dialog-wide" : ""} ${unframed ? "unframed" : ""} ${headerless ? "headerless" : ""}`}
          data-recessed={recessed || undefined}
          data-panel-depth={baseDepth + depthOffset}
          aria-describedby={undefined}
          style={
            {
              "--preferred-width": `${width ?? (wide ? 880 : 800)}px`,
              transform: `translate(calc(-50% + ${position.x}px),calc(-50% + ${position.y}px))`,
              zIndex: 101 + Math.max(0, layers.indexOf(node!)) * 2,
            } as CSSProperties
          }
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const target = initialFocus ? panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) : panelRef.current;
            (target ?? panelRef.current)?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            void close();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="elastic-panel-content">
            {unframed || headerless ? (
              <D.Title className="sr-only">{title}</D.Title>
            ) : (
              <header
                className="dialog-header"
                onPointerDown={(e) => {
                  if (
                    e.button !== 0 ||
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
              </header>
            )}
            <div className="dialog-body">{children}</div>
            {footer && <footer className="dialog-footer">{footer}</footer>}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import { t } from "../../i18n";
import {
  hasOpenTransient,
  isTransientTarget,
  layers,
  resolveReturnFocus,
  type LayerRect,
  type LayerSize,
} from "../../state/layers";
import { DismissalFooter } from "../kit/dismissal";
import { cn } from "../kit/utils";
import {
  ActionsContext,
  CloseContext,
  DialogActions,
  HeaderContext,
  PanelHeader,
  PanelStateContext,
  usePanelState,
  type DialogProps,
  type PanelState,
} from "./Dialog";
import { IconButton, Notice } from "./index";

export { PanelHeader, usePanelState };

export type PanelProps = DialogProps & {
  size?: LayerSize;
  labelledBy?: string;
  onPanelFrame?: (rect: LayerRect | null) => void;
  role?: "dialog" | "region";
  expanded?: boolean;
  onToggleWidth?: () => void;
  viewKey?: string;
  headerNavigation?: ReactNode;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
};

const switcherSelector = "[data-workspace-switcher], [data-layer-switcher], [data-global-feedback]";

export default function Panel({
  layerId,
  open = true,
  onClose,
  dirty,
  busy,
  onCancel,
  title,
  description,
  children,
  footer,
  actions,
  leading,
  headerDetail,
  headerNavigation,
  headerless,
  className = "",
  initialFocus,
  returnFocus,
  size = "xl",
  labelledBy,
  onPanelFrame,
  role = "dialog",
  expanded = false,
  onToggleWidth,
  viewKey,
  onEscapeKeyDown,
}: PanelProps) {
  const generatedId = useId();
  const id = layerId ?? generatedId;
  const snapshot = layers.use();

  const [node, setNode] = useState<HTMLElement | null>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [headerCount, setHeaderCount] = useState(0);
  const registerHeader = useCallback(() => {
    setHeaderCount((count) => count + 1);
    return () => setHeaderCount((count) => count - 1);
  }, []);
  const headerContext = useMemo(
    () => ({ target: headerTarget, register: registerHeader }),
    [headerTarget, registerHeader],
  );

  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const [actionCount, setActionCount] = useState(0);
  const registerActions = useCallback(() => {
    setActionCount((count) => count + 1);
    return () => setActionCount((count) => count - 1);
  }, []);
  const actionsContext = useMemo(
    () => ({ target: footerTarget, register: registerActions }),
    [footerTarget, registerActions],
  );

  const [panelStates, setPanelStates] = useState<Record<string, PanelState>>({});
  const updatePanelState = useCallback((key: string, state?: PanelState) => {
    setPanelStates((previous) => {
      if (!state?.dirty && !state?.busy) {
        if (!previous[key]) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }
      if (
        previous[key]?.dirty === state.dirty &&
        previous[key]?.busy === state.busy &&
        previous[key]?.onCancel === state.onCancel
      ) {
        return previous;
      }
      return { ...previous, [key]: state };
    });
  }, []);

  const contributions = Object.values(panelStates);
  const running = contributions.filter((state) => state.busy);
  const effectiveDirty = Boolean(dirty || contributions.some((state) => state.dirty));
  const effectiveBusy = Boolean(busy || running.length > 0);
  const effectiveCancel = onCancel ?? (running.length === 1 ? running[0].onCancel : undefined);

  const self = snapshot.find((layer) => layer.id === id);
  const status = self?.dismissal ?? "none";
  const recessed = Boolean(self && snapshot.at(-1)?.id !== id);
  const stack = layers.stack(id);

  const triggerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const latest = useRef({
    onClose,
    dirty: effectiveDirty,
    busy: effectiveBusy,
    onCancel: effectiveCancel,
    onEscapeKeyDown,
  });
  latest.current = {
    onClose,
    dirty: effectiveDirty,
    busy: effectiveBusy,
    onCancel: effectiveCancel,
    onEscapeKeyDown,
  };

  useLayoutEffect(() => {
    if (!open) return;
    triggerRef.current =
      layers.consumeSwitchTrigger() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.open({
      id,
      kind: "panel",
      onClose: () => latest.current.onClose(),
      dirty: latest.current.dirty,
      busy: latest.current.busy,
      onCancel: latest.current.onCancel,
    });
    return () => {
      layers.remove(id);
      const trigger = triggerRef.current;
      const selector = returnFocusRef.current;
      requestAnimationFrame(() => {
        if (layers.top()) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
        resolveReturnFocus(trigger, selector)?.focus({ preventScroll: true });
      });
    };
  }, [open, id]);

  useLayoutEffect(() => {
    layers.update(id, {
      dirty: effectiveDirty,
      busy: effectiveBusy,
      onClose,
      onCancel: effectiveCancel,
    });
  }, [id, effectiveDirty, effectiveBusy, onClose, effectiveCancel]);

  useLayoutEffect(() => {
    if (!open || !node || layers.top()?.id !== id) return;
    const active = document.activeElement;
    if (!initialFocus && active instanceof HTMLElement && node.contains(active) && !active.closest("[hidden], [inert]")) {
      return;
    }
    const target = initialFocus
      ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node
      : node;
    if (active !== target) target.focus({ preventScroll: true });
  }, [open, node, id, initialFocus, viewKey]);

  const reportFrame = useRef(onPanelFrame);
  reportFrame.current = onPanelFrame;
  useLayoutEffect(() => {
    if (!node || !reportFrame.current) return;
    const report = () => reportFrame.current?.(node.getBoundingClientRect());
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (!layers.get().some((layer) => layer.kind === "panel" && layer.id !== id)) {
        reportFrame.current?.(null);
      }
    };
  }, [node, id, size, expanded]);

  useEffect(() => {
    if (!open || !node) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (layers.top()?.id !== id || hasOpenTransient()) return;
      if (status === "none") latest.current.onEscapeKeyDown?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      layers.dismiss(id);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, node, id, status]);

  useEffect(() => {
    if (!open || !node || role === "region") return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || layers.top()?.id !== id) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        node.contains(target) ||
        target.closest(switcherSelector) ||
        isTransientTarget(target)
      ) {
        return;
      }
      layers.dismiss(id);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open, node, id, role]);

  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const close = useCallback(() => {
    void layers.close(id);
  }, [id]);

  const closeContext = useMemo(
    () => ({
      id,
      busy: effectiveBusy,
      close,
      feedback: (message: string, error: boolean) => setFeedback({ message, error }),
    }),
    [id, effectiveBusy, close],
  );

  if (!open || typeof document === "undefined") return null;

  const closeLabel = role === "region" ? t("backToHome") : t("close");
  const widthClass =
    size === "m"
      ? expanded
        ? "w-[min(var(--layer-xl),calc(100vw-2*var(--layer-side-margin)))]"
        : "w-[min(var(--layer-m),calc(100vw-2*var(--layer-side-margin)))]"
      : expanded
        ? "w-[min(1200px,calc(100vw-2*var(--layer-side-margin)))]"
        : "w-[min(var(--layer-xl),calc(100vw-2*var(--layer-side-margin)))]";

  return createPortal(
    <>
      {role === "region" && (
        <div
          aria-hidden="true"
          className="fixed inset-0"
          style={{ zIndex: stack.panel - 1 }}
          onPointerDown={(event) => {
            if (event.button !== 0 || layers.top()?.id !== id || hasOpenTransient()) return;
            event.preventDefault();
            layers.dismiss(id);
          }}
        />
      )}
      <div
        data-slot="workspace-host"
        className="pointer-events-none fixed inset-0 flex items-center justify-center px-[var(--layer-side-margin)] py-[var(--layer-panel-inset)]"
        style={{ zIndex: stack.panel }}
      >
        <section
          ref={setNode}
          role={role}
          tabIndex={-1}
          aria-labelledby={labelledBy ?? `${id}-title`}
          aria-describedby={description ? `${id}-description` : undefined}
          data-slot="workspace-shell"
          data-layer-kind="panel"
          data-layer-size={size}
          data-expanded={expanded || undefined}
          inert={recessed || undefined}
          className={cn(
            "dialog layer-panel pointer-events-auto flex min-h-0 max-h-full flex-col overflow-hidden rounded-shell border border-border bg-surface-raised text-foreground shadow-lg outline-none max-[759px]:w-[calc(100vw-2*var(--layer-side-margin))] portrait:w-[calc(100vw-2*var(--layer-side-margin))] dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
            widthClass,
            size === "m" && "node-panel",
            headerless && "headerless",
            className,
          )}
        >
          {headerless ? (
            <>
              <h2 className="sr-only" id={`${id}-title`}>
                {title}
              </h2>
              <div
                className="layer-custom-header shrink-0 min-w-0 [&[hidden]]:hidden"
                ref={setHeaderTarget}
                hidden={!headerCount}
              />
            </>
          ) : (
            <header
              data-slot="workspace-header"
              className="dialog-header flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-2.5"
            >
              {leading}
              <h2
                id={`${id}-title`}
                className="panel-title min-w-0 truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground"
              >
                {title}
              </h2>
              {headerNavigation}
              <div className="actions ml-auto flex shrink-0 items-center gap-1.5">
                {actions}
                {onToggleWidth && (
                  <IconButton
                    icon={expanded ? Minimize2 : Maximize2}
                    label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")}
                    aria-pressed={Boolean(expanded)}
                    onClick={onToggleWidth}
                  />
                )}
                <IconButton icon={X} label={closeLabel} onClick={close} />
              </div>
            </header>
          )}
          {headerDetail && <div className="shrink-0 px-5 pt-3">{headerDetail}</div>}
          {description && (
            <div
              id={`${id}-description`}
              className="dialog-description shrink-0 border-b border-border px-5 py-2.5 text-small leading-5 text-text-secondary"
            >
              {description}
            </div>
          )}
          <HeaderContext.Provider value={headerContext}>
            <PanelStateContext.Provider value={updatePanelState}>
              <CloseContext.Provider value={closeContext}>
                <ActionsContext.Provider value={actionsContext}>
                  <div
                    data-slot="workspace-body"
                    className="dialog-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
                    inert={status !== "none" || undefined}
                  >
                    <div className="dialog-swap [&[hidden]]:hidden">
                      {feedback && (
                        <Notice tone={feedback.error ? "danger" : "success"}>
                          {feedback.message}
                        </Notice>
                      )}
                      {children}
                    </div>
                  </div>
                </ActionsContext.Provider>
                <footer
                  ref={setFooterTarget}
                  data-slot="workspace-footer"
                  className="dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-5 py-3 [&[hidden]]:hidden"
                  hidden={status !== "none" || (!footer && !actionCount)}
                >
                  {footer}
                </footer>
              </CloseContext.Provider>
            </PanelStateContext.Provider>
          </HeaderContext.Provider>
          <DismissalFooter
            status={status}
            cancellable={Boolean(effectiveCancel)}
            onDiscard={() => void layers.confirmDiscard(id)}
            onStopAndClose={() => layers.stopAndClose(id)}
            onKeepOpen={() => layers.keepOpen(id)}
          />
        </section>
      </div>
    </>,
    document.body,
  );
}

export function PanelFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogActions className={`panel-footer-content ${className ?? ""}`}>
      {children}
    </DialogActions>
  );
}

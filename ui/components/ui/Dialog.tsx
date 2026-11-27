import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "lucide-react";
import { t } from "../../i18n";
import { isDesktop } from "../../platform";
import {
  hasOpenTransient,
  isTransientTarget,
  layers,
  resolveReturnFocus,
  type LayerKind,
  type LayerRect,
  type LayerSize,
} from "../../state/layers";
import { notify } from "../../state/connector";
import {
  DialogBackdrop,
  DialogPrimitive,
  DialogSubviewContext,
  type DialogSubviewEntry,
} from "../kit/dialog";
import { DismissalFooter } from "../kit/dismissal";
import { useDialogFinalFocus } from "../kit/dialog-focus";
import { cn } from "../kit/utils";
import { IconButton, Notice } from "./index";

export type { LayerKind, LayerRect, LayerSize };

export type DialogProps = {
  layerId?: string;
  open?: boolean;
  onClose: () => void | Promise<void>;
  dirty?: boolean;
  busy?: boolean;
  onCancel?: () => void | boolean | Promise<void | boolean>;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  headerDetail?: ReactNode;
  stepBar?: ReactNode;
  headerless?: boolean;
  className?: string;
  initialFocus?: string;
  returnFocus?: string;
};

export const CloseContext = createContext<{
  id: string;
  busy?: boolean;
  close: () => void;
  feedback: (message: string, error: boolean) => void;
} | null>(null);

export type PanelState = {
  dirty?: boolean;
  busy?: boolean;
  onCancel?: DialogProps["onCancel"];
};

export const PanelStateContext = createContext<
  ((id: string, state?: PanelState) => void) | null
>(null);

export const HeaderContext = createContext<{
  target: HTMLElement | null;
  register: () => () => void;
} | null>(null);

export const ActionsContext = createContext<{
  target: HTMLElement | null;
  register: () => () => void;
} | null>(null);

/** Completion respects Keep open and routes results from closed owners to global feedback. */
export function useDialogCompletion(onComplete: () => void | Promise<void>) {
  const layerId = useId();
  const isOpen = () => layers.get().some((layer) => layer.id === layerId);
  return {
    layerId,
    isOpen,
    feedback: (message: string, error = false) => {
      if (!isOpen()) {
        notify(message, { errorSource: error ? `layer:${layerId}` : undefined });
      }
    },
    finish: (message = t("activity.completed")) =>
      isOpen() ? layers.complete(layerId, onComplete) : notify(message),
  };
}

export function useDialogFeedback() {
  const context = useContext(CloseContext);
  const source = useId();
  return (message: string, error = false) => {
    if (context && layers.get().some((layer) => layer.id === context.id)) {
      context.feedback(message, error);
    } else {
      notify(message, { errorSource: error ? `action:${source}` : undefined });
    }
  };
}

export function DialogClose({
  asChild,
  onClick,
  type = "button",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const context = useContext(CloseContext);
  const handle = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) context?.close();
  };
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{
      onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
    }>;
    return cloneElement(child, {
      ...props,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        child.props.onClick?.(event);
        if (!event.defaultPrevented) handle(event);
      },
    });
  }
  return (
    <button {...props} type={type} onClick={handle}>
      {children}
    </button>
  );
}

/** Register draft and work state with the owning workspace or dialog shell. */
export function usePanelState({
  dirty = false,
  busy = false,
  onCancel,
}: PanelState) {
  const update = useContext(PanelStateContext);
  const id = useId();
  useLayoutEffect(() => {
    update?.(id, { dirty, busy, onCancel });
  }, [update, id, dirty, busy, onCancel]);
  useLayoutEffect(() => () => update?.(id), [update, id]);
}

/** Keep feature-owned headers outside the scrolling body. */
export function PanelHeader({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const context = useContext(HeaderContext);
  useLayoutEffect(
    () => (active ? context?.register() : undefined),
    [active, context?.register],
  );
  return active
    ? context
      ? context.target && createPortal(children, context.target)
      : children
    : null;
}

/** Keep feature-owned actions in the fixed footer and preserve their native form association. */
export function DialogActions({
  children,
  className = "actions",
}: {
  children: ReactNode;
  className?: string;
}) {
  const context = useContext(ActionsContext);
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => context?.register(), [context?.register]);
  useLayoutEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form || !actions.current) return;
    if (!form.id) form.id = id;
    actions.current.querySelectorAll("button").forEach((button) => {
      if (!button.hasAttribute("form")) button.setAttribute("form", form.id);
    });
  }, [context?.target, children, id]);
  const content = (
    <div ref={actions} className={className}>
      {children}
    </div>
  );
  if (!context) return content;
  return (
    <>
      <span hidden ref={anchor} />
      {context.target && createPortal(content, context.target)}
    </>
  );
}

export default function Dialog({
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
  stepBar,
  headerless,
  className = "",
  initialFocus,
  returnFocus,
}: DialogProps) {
  const generatedId = useId();
  const id = layerId ?? generatedId;
  const snapshot = layers.use();
  const fallbackFinalFocus = useDialogFinalFocus();

  const [node, setNode] = useState<HTMLDivElement | null>(null);
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

  const [view, setView] = useState<DialogSubviewEntry | null>(null);
  const [viewBody, setViewBody] = useState<HTMLElement | null>(null);
  const [viewFooter, setViewFooter] = useState<HTMLElement | null>(null);
  const viewContext = useMemo(
    () => ({ set: setView, body: viewBody, footer: viewFooter }),
    [viewBody, viewFooter],
  );
  const back = useCallback(() => {
    const current = view;
    if (!current) return;
    current.back();
    requestAnimationFrame(() => current.trigger?.focus({ preventScroll: true }));
  }, [view]);

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

  const allowed = !open || layers.canOpen("dialog", id);
  const self = snapshot.find((layer) => layer.id === id);
  const status = self?.dismissal ?? "none";
  const selfIndex = snapshot.findIndex((layer) => layer.id === id);
  const recessed = Boolean(self && snapshot.at(-1)?.id !== id);
  const showScrim = selfIndex > 0;
  const depth = Math.max(
    0,
    snapshot.filter((layer) => layer.kind === "dialog").findIndex((layer) => layer.id === id),
  );
  const stack = layers.stack(id);

  const triggerRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClose, dirty: effectiveDirty, busy: effectiveBusy, onCancel: effectiveCancel });
  latest.current = { onClose, dirty: effectiveDirty, busy: effectiveBusy, onCancel: effectiveCancel };

  useLayoutEffect(() => {
    if (!open || !allowed) return;
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layers.open({ id, kind: "dialog", ...latest.current });
    return () => layers.remove(id);
  }, [open, allowed, id]);

  useLayoutEffect(() => {
    layers.update(id, {
      dirty: effectiveDirty,
      busy: effectiveBusy,
      onClose,
      onCancel: effectiveCancel,
    });
  }, [id, effectiveDirty, effectiveBusy, onClose, effectiveCancel]);

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

  const resolveInitialFocus = useCallback(() => {
    if (!node) return true;
    if (initialFocus) {
      return node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && node.contains(active) && !active.closest("[hidden], [inert]")) {
      return false;
    }
    return node;
  }, [node, initialFocus]);

  const resolveFinalFocus = useCallback(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !node?.contains(active)
    ) {
      return false;
    }
    const fallback = fallbackFinalFocus();
    return (
      resolveReturnFocus(
        triggerRef.current,
        returnFocus,
        fallback instanceof HTMLElement ? fallback : null,
      ) ?? false
    );
  }, [node, returnFocus, fallbackFinalFocus]);

  const handleEscape = useCallback(
    (event: { preventDefault: () => void; defaultPrevented: boolean }) => {
      if (event.defaultPrevented || layers.top()?.id !== id || hasOpenTransient()) return;
      event.preventDefault();
      if (view && status === "none") back();
      else layers.dismiss(id);
    },
    [id, view, status, back],
  );

  if (!open || !allowed) return null;

  return (
    <DialogPrimitive.Root
      modal={false}
      open={open && allowed}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        if (details.reason === "focus-out") return;
        if (layers.top()?.id !== id) return;
        if (details.reason === "outside-press") {
          const target = details.event?.target ?? null;
          if (
            isTransientTarget(target) ||
            (target instanceof Element && target.closest("[data-global-feedback]"))
          ) {
            return;
          }
          layers.dismiss(id);
          return;
        }
        if (details.reason === "escape-key") {
          if (hasOpenTransient()) return;
          if (view && status === "none") back();
          else layers.dismiss(id);
          return;
        }
        void layers.close(id);
      }}
    >
      <DialogPrimitive.Portal>
        {showScrim && (
          <DialogBackdrop
            forceRender
            className="layer-scrim"
            style={{ zIndex: stack.scrim }}
          />
        )}
        <DialogPrimitive.Popup
          ref={setNode}
          data-slot="dialog-popup"
          data-layer-kind="dialog"
          data-layer-size="m"
          data-panel-depth={depth + 1}
          inert={recessed || undefined}
          initialFocus={resolveInitialFocus}
          finalFocus={resolveFinalFocus}
          style={{ zIndex: stack.dialog }}
          onKeyDown={(event) => {
            if (event.key === "Escape") handleEscape(event);
          }}
          className={cn(
            "dialog layer-dialog fixed left-1/2 top-1/2 flex min-h-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-dialog border border-border bg-surface-raised text-foreground shadow-lg outline-none transition-[opacity,scale] duration-(--motion-base) ease-(--ease-enter) data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0 data-ending-style:scale-95 data-ending-style:duration-(--motion-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-none dark:border-border-strong dark:shadow-[inset_0_1px_0_rgb(255_255_255/6%),var(--shadow-lg)]",
            "w-[min(var(--layer-m),calc(100vw-2*var(--layer-side-margin)))]",
            isDesktop
              ? "max-h-[calc(100dvh-2*var(--layer-top-desktop))]"
              : "max-h-[calc(100dvh-2*var(--layer-top-browser))]",
            headerless && "headerless",
            className,
          )}
        >
          {headerless ? (
            <>
              <DialogPrimitive.Title id={`${id}-title`} className="sr-only">
                {title}
              </DialogPrimitive.Title>
              <div
                className="layer-custom-header shrink-0 min-w-0 [&[hidden]]:hidden"
                ref={setHeaderTarget}
                hidden={!headerCount}
              />
            </>
          ) : (
            <header
              data-slot="dialog-header"
              className="dialog-header flex min-h-[46px] shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3"
            >
              {view ? (
                <IconButton icon={ChevronLeft} label={t("back")} onClick={back} />
              ) : (
                leading
              )}
              <DialogPrimitive.Title
                id={`${id}-title`}
                className="min-w-0 flex-1 text-left text-body font-semibold leading-5 text-foreground"
              >
                {view ? (
                  <>
                    <span className="dialog-breadcrumb font-normal text-text-secondary">
                      {title}
                    </span>
                    <span aria-hidden="true"> / </span>
                    {view.title}
                  </>
                ) : (
                  title
                )}
              </DialogPrimitive.Title>
              <div className="actions ml-auto flex shrink-0 items-center gap-1.5">
                {actions}
                <IconButton icon={X} label={t("close")} onClick={close} />
              </div>
            </header>
          )}
          {!view && headerDetail && (
            <div className="shrink-0 px-5 pt-3">{headerDetail}</div>
          )}
          {description && (
            <DialogPrimitive.Description
              id={`${id}-description`}
              className="dialog-description shrink-0 px-5 pt-3 text-small leading-5 text-text-secondary"
            >
              {description}
            </DialogPrimitive.Description>
          )}
          {!view && stepBar && <div className="shrink-0 px-5 pt-3">{stepBar}</div>}
          <HeaderContext.Provider value={headerContext}>
            <PanelStateContext.Provider value={updatePanelState}>
              <CloseContext.Provider value={closeContext}>
                <DialogSubviewContext.Provider value={viewContext}>
                  <ActionsContext.Provider value={actionsContext}>
                    <div
                      data-slot="dialog-body"
                      className="dialog-body dialog-view-stack relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
                      inert={status !== "none" || undefined}
                    >
                      <div
                        className="dialog-swap [&[hidden]]:hidden"
                        hidden={Boolean(view)}
                        inert={Boolean(view) || undefined}
                      >
                        {feedback && (
                          <Notice tone={feedback.error ? "danger" : "success"}>
                            {feedback.message}
                          </Notice>
                        )}
                        {children}
                      </div>
                      <div
                        className="dialog-swap [&[hidden]]:hidden"
                        ref={setViewBody}
                        hidden={!view}
                        inert={!view || undefined}
                        tabIndex={-1}
                      />
                    </div>
                  </ActionsContext.Provider>
                  <footer
                    ref={setFooterTarget}
                    data-slot="dialog-footer"
                    className="dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-5 py-3 [&[hidden]]:hidden"
                    hidden={Boolean(view) || status !== "none" || (!footer && !actionCount)}
                  >
                    {footer}
                  </footer>
                  <footer
                    ref={setViewFooter}
                    data-slot="dialog-footer"
                    className="dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-5 py-3 [&[hidden]]:hidden"
                    hidden={!view || status !== "none"}
                  />
                </DialogSubviewContext.Provider>
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
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

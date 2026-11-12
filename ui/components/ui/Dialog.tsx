import { createContext, useCallback, useContext, useMemo, useId, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as D } from 'radix-ui';
import { ChevronLeft, X } from 'lucide-react';
import { isDesktop } from '../../platform';
import { t } from '../../i18n';
import { useReducedMotion } from '../../state/appEnvironment';
import { consumeOutsidePointer, layers, layerTrigger } from '../../state/layers';
import { notify } from '../../state/connector';
import { layerFrame, type LayerSize, type LayerTokens } from './layerFrame';
import { Button, IconButton } from './index';
import './Dialog.css';

const CloseContext = createContext<{ id: string; busy?: boolean; close: () => void } | null>(null);
export function useDialogClose() { return useContext(CloseContext)?.close; }
export function useDialogFeedback() {
  const context = useContext(CloseContext);
  return (message: string, error = false) => {
    if (context && !layers.get().some(layer => layer.id === context.id)) notify(message, error);
  };
}
export function DialogClose(props: ComponentProps<typeof D.Close>) {
  const context = useContext(CloseContext);
  return <D.Close {...props} onClickCapture={event => {
    if (context?.busy) { event.preventDefault(); event.stopPropagation(); context.close(); }
    else props.onClickCapture?.(event);
  }} />;
}

type View = { title: string; back: () => void; trigger: HTMLElement | null };
const ViewContext = createContext<{
  set: (view: View | null) => void; body: HTMLElement | null; footer: HTMLElement | null;
} | null>(null);

/** A retained view inside its owner's shell, never another modal layer. */
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

const ActionsContext = createContext<{ target: HTMLElement | null; register: () => () => void } | null>(null);

/** Keep feature-owned actions in the fixed footer and preserve their native form association. */
export function DialogActions({ children, className = 'actions' }: { children: ReactNode; className?: string }) {
  const context = useContext(ActionsContext), id = useId();
  const anchor = useRef<HTMLSpanElement>(null), actions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => context?.register(), [context?.register]);
  useLayoutEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form || !actions.current) return;
    if (!form.id) form.id = id;
    actions.current.querySelectorAll('button').forEach(button => { if (!button.hasAttribute('form')) button.setAttribute('form', form.id); });
  }, [context?.target, children, id]);
  const content = <div ref={actions} className={className}>{children}</div>;
  if (!context) return content;
  return <><span hidden ref={anchor} />{context.target && createPortal(content, context.target)}</>;
}

/** Completion respects Keep open and routes results from closed owners to global feedback. */
export function useDialogCompletion(onComplete: () => void | Promise<void>) {
  const layerId = useId();
  const isOpen = () => layers.get().some(layer => layer.id === layerId);
  return { layerId, isOpen, feedback: (message: string, error = false) => { if (!isOpen()) notify(message, error); }, finish: (message = t('activity.completed')) => isOpen()
    ? layers.complete(layerId, onComplete) : notify(message) };
}

export type DialogProps = {
  layerId?: string;
  size: LayerSize;
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
function readTokens(): LayerTokens {
  const css = getComputedStyle(document.documentElement);
  const fallback: LayerTokens = { sizes: { s: 400, m: 560, l: 720, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
  const value = (name: string, defaultValue: number) => {
    const raw = css.getPropertyValue(name).trim();
    const parsed = raw.endsWith('px') ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  };
  return { sizes: { s: value('--layer-s', fallback.sizes.s), m: value('--layer-m', fallback.sizes.m),
    l: value('--layer-l', fallback.sizes.l), xl: value('--layer-xl', fallback.sizes.xl) },
    margin: value('--layer-side-margin', fallback.margin), desktopTop: value('--layer-top-desktop', fallback.desktopTop), browserTop: value('--layer-top-browser', fallback.browserTop) };
}

export default function Dialog({ layerId, size, open = true, onClose, dirty, busy, onCancel, title, description, children,
  footer, actions, leading, headerDetail, stepBar, headerless, className = '', initialFocus, returnFocus }: DialogProps) {
  const generatedId = useId(), id = layerId ?? generatedId, snapshot = layers.use(), reduced = useReducedMotion();
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const [actionCount, setActionCount] = useState(0);
  const registerActions = useCallback(() => { setActionCount(count => count + 1); return () => setActionCount(count => count - 1); }, []);
  const actionsContext = useMemo(() => ({ target: footerTarget, register: registerActions }), [footerTarget, registerActions]);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<View | null>(null);
  const viewHeight = useRef<number | undefined>(undefined), currentNode = useRef(node);
  currentNode.current = node;
  const setActiveView = useCallback((next: View | null) => {
    if (next) viewHeight.current = currentNode.current?.getBoundingClientRect().height || undefined;
    setView(next);
  }, []);
  const [viewBody, setViewBody] = useState<HTMLElement | null>(null), [viewFooter, setViewFooter] = useState<HTMLElement | null>(null);
  const viewContext = useMemo(() => ({ set: setActiveView, body: viewBody, footer: viewFooter }), [viewBody, viewFooter, setActiveView]);
  const back = () => { view?.back(); requestAnimationFrame(() => view?.trigger?.focus({ preventScroll: true })); };
  const [frame, setFrame] = useState<ReturnType<typeof layerFrame>>();
  const source = useRef<ReturnType<typeof layerTrigger>>(undefined);
  const focusSource = useRef<HTMLElement | null>(null);
  const safeAction = useRef<HTMLButtonElement>(null);
  const self = snapshot.find(layer => layer.id === id);
  const allowed = !open || layers.canOpen('dialog', id);
  const dialogs = snapshot.filter(layer => layer.kind === 'dialog');
  const parent = dialogs[dialogs.findIndex(layer => layer.id === id) - 1];
  const portalReady = !!self && (!parent || parent.ready);
  const recessed = !!self && snapshot.at(-1)?.id !== id;
  const depth = Math.max(0, snapshot.filter(layer => layer.kind === 'dialog').findIndex(layer => layer.id === id));
  const latest = useRef({ onClose, dirty, busy, onCancel });
  latest.current = { onClose, dirty, busy, onCancel };
  useLayoutEffect(() => {
    if (!open || !allowed) return;
    source.current = layerTrigger();
    focusSource.current = source.current?.element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.open({ id, kind: 'dialog', node: null, trigger: focusSource.current, returnFocus, ...latest.current });
    return () => layers.remove(id);
  }, [open, allowed, id, returnFocus]);
  // Parent Radix effects finish before a child portal mounts, so hideOthers cannot hide the child.
  useEffect(() => {
    if (!node) return;
    layers.ready(id, node);
    return layers.observeOutsidePointer(id);
  }, [node, id]);
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      setFrame(layerFrame('dialog', size, 'center', { width: innerWidth, height: innerHeight, desktop: isDesktop },
        readTokens(), node.scrollHeight, source.current?.rect));
    };
    measure();
    const focusFrame = requestAnimationFrame(() => {
      if (layers.top()?.id !== id) return;
      (initialFocus ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node : node).focus({ preventScroll: true });
    });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(focusFrame); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [node, id, size, initialFocus]);
  useLayoutEffect(() => { layers.update(id, { dirty, busy, onClose, onCancel }); }, [id, dirty, busy, onClose, onCancel]);
  useLayoutEffect(() => { if (self?.dismissal !== 'none') safeAction.current?.focus({ preventScroll: true }); }, [self]);
  const status = self?.dismissal ?? 'none';
  const close = () => { void layers.close(id); };
  return <D.Root open={open && allowed && portalReady} onOpenChange={next => { if (!next) void layers.close(id); }}>
    <D.Portal>
      <D.Overlay className="layer-scrim" style={{ zIndex: 201 + depth * 2 }} onPointerDown={event => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        consumeOutsidePointer(event.nativeEvent);
        layers.dismiss(id);
      }} />
      <D.Content ref={setNode} className={`dialog layer-dialog ${headerless ? 'headerless' : ''} ${className}`}
        data-panel-depth={depth + 1} inert={recessed || undefined}
        aria-describedby={description ? `${id}-description` : undefined}
        style={{ left: frame?.x, top: frame?.y, width: frame?.width ?? `var(--layer-${size})`, height: view ? viewHeight.current : undefined, maxHeight: frame?.maxHeight,
          visibility: frame ? undefined : 'hidden', zIndex: 202 + depth * 2,
          '--layer-entry-x': `${-(frame?.entry.x ?? 0)}px`, '--layer-entry-y': `${-(frame?.entry.y ?? -6)}px`,
          animation: reduced ? 'none' : undefined } as CSSProperties}
        onOpenAutoFocus={event => {
          event.preventDefault();
          const host = event.target instanceof HTMLElement ? event.target : node;
          const target = initialFocus ? host?.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) : undefined;
          (target ?? host)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={event => { event.preventDefault(); layers.restoreFocus({ trigger: focusSource.current, returnFocus }); }}
        onEscapeKeyDown={event => { event.preventDefault(); if (view && status === 'none') back(); else layers.dismiss(id); }}
        onPointerDownOutside={event => {
          event.preventDefault();
          if (event.detail.originalEvent.button !== 0 || event.detail.originalEvent.defaultPrevented) return;
          consumeOutsidePointer(event.detail.originalEvent);
          layers.dismiss(id);
        }}
        onInteractOutside={event => event.preventDefault()}>
        {headerless ? <D.Title className="sr-only">{title}</D.Title> : <header className="dialog-header">
          {view ? <IconButton icon={ChevronLeft} label={t('back')} onClick={back} /> : leading}<D.Title>{view ? <><span className="dialog-breadcrumb">{title}</span><span aria-hidden="true"> / </span>{view.title}</> : title}</D.Title><div className="actions">{actions}<IconButton icon={X} label={t('close')} onClick={close} /></div>
        </header>}
        {!view && headerDetail}
        {description && <D.Description className="dialog-description" id={`${id}-description`}>{description}</D.Description>}
        {!view && stepBar}
        <CloseContext.Provider value={{ id, busy, close }}>
        <ViewContext.Provider value={viewContext}>
        <ActionsContext.Provider value={actionsContext}>
          <div className="dialog-body dialog-view-stack" inert={status !== 'none' || undefined}>
            <div className="dialog-swap" hidden={!!view} inert={!!view || undefined}>{children}</div>
            <div className="dialog-swap" ref={setViewBody} hidden={!view} inert={!view || undefined} tabIndex={-1} />
          </div>
        </ActionsContext.Provider>
        <footer ref={setFooterTarget} className="dialog-footer" hidden={!!view || status !== 'none' || !footer && !actionCount}>{footer}</footer>
        <footer ref={setViewFooter} className="dialog-footer" hidden={!view || status !== 'none'} />
        </ViewContext.Provider>
        </CloseContext.Provider>
        {status !== 'none' &&
          <footer className="dialog-footer layer-dismissal" role="status">
            <p>{t(status === 'discard' ? 'layers.discard' : 'layers.runningClose')}</p>
            <div className="actions">
              {status === 'discard' && <Button variant="danger" onClick={close}>{t('layers.discardAction')}</Button>}
              {status === 'running' && onCancel && <Button variant="danger" onClick={() => void layers.stopAndClose(id)}>{t('layers.stopClose')}</Button>}
              <Button ref={safeAction} variant="primary" onClick={() => layers.keepOpen(id)}>{t(status === 'discard' ? 'layers.keepEditing' : 'layers.keepOpen')}</Button>
            </div>
          </footer>}
      </D.Content>
    </D.Portal>
  </D.Root>;
}

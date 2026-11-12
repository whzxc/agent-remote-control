import { createContext, useCallback, useContext, useMemo, useId, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { isDesktop } from '../../platform';
import { t } from '../../i18n';
import { useReducedMotion } from '../../state/appEnvironment';
import { consumeOutsidePointer, layers, layerTrigger } from '../../state/layers';
import { layerFrame, type LayerSize, type LayerTokens } from './layerFrame';
import { Button, IconButton } from './index';
import './Dialog.css';
import tokenSheet from '../../../design/tokens.css?raw';

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

/** Completion respects a pending-close withdrawal while explicit Close remains unconditional. */
export function useDialogCompletion(onComplete: () => void | Promise<void>) {
  const layerId = useId();
  return { layerId, finish: () => layers.complete(layerId, onComplete) };
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
  // The authored sheet also supplies geometry before host CSS is attached (including SSR consumers).
  const value = (name: string) => parseFloat(css.getPropertyValue(name)
    || tokenSheet.match(new RegExp(`${name}:\\s*([0-9]+)px`))![1]);
  return { sizes: { s: value('--layer-s'), m: value('--layer-m'), l: value('--layer-l'), xl: value('--layer-xl') },
    margin: value('--layer-side-margin'), desktopTop: value('--layer-top-desktop'), browserTop: value('--layer-top-browser') };
}

export default function Dialog({ layerId, size, open = true, onClose, dirty, busy, onCancel, title, description, children,
  footer, actions, leading, headerDetail, stepBar, headerless, className = '', initialFocus, returnFocus }: DialogProps) {
  const generatedId = useId(), id = layerId ?? generatedId, snapshot = layers.use(), reduced = useReducedMotion();
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const [actionCount, setActionCount] = useState(0);
  const registerActions = useCallback(() => { setActionCount(count => count + 1); return () => setActionCount(count => count - 1); }, []);
  const actionsContext = useMemo(() => ({ target: footerTarget, register: registerActions }), [footerTarget, registerActions]);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<ReturnType<typeof layerFrame>>();
  const source = useRef<ReturnType<typeof layerTrigger>>(undefined);
  const focusSource = useRef<HTMLElement | null>(null);
  const safeAction = useRef<HTMLButtonElement>(null);
  const self = snapshot.find(layer => layer.id === id);
  const allowed = layers.canOpen('dialog', id);
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
  useLayoutEffect(() => { if (self?.dismissal !== 'none') safeAction.current?.focus({ preventScroll: true }); }, [self?.dismissal]);
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
        style={{ left: frame?.x, top: frame?.y, width: frame?.width ?? `var(--layer-${size})`, maxHeight: frame?.maxHeight,
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
        onEscapeKeyDown={event => { event.preventDefault(); layers.dismiss(id); }}
        onPointerDownOutside={event => {
          event.preventDefault();
          if (event.detail.originalEvent.button !== 0 || event.detail.originalEvent.defaultPrevented) return;
          consumeOutsidePointer(event.detail.originalEvent);
          layers.dismiss(id);
        }}
        onInteractOutside={event => event.preventDefault()}>
        {headerless ? <D.Title className="sr-only">{title}</D.Title> : <header className="dialog-header">
          {leading}<D.Title>{title}</D.Title><div className="actions">{actions}<IconButton icon={X} label={t('close')} onClick={close} /></div>
        </header>}
        {headerDetail}
        {description && <D.Description className="dialog-description" id={`${id}-description`}>{description}</D.Description>}
        {stepBar}
        <ActionsContext.Provider value={actionsContext}>
          <div className="dialog-body" inert={status !== 'none' || undefined}>{children}</div>
        </ActionsContext.Provider>
        <footer ref={setFooterTarget} className="dialog-footer" hidden={status !== 'none' || !footer && !actionCount}>{footer}</footer>
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

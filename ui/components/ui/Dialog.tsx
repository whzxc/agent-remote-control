import { animate } from "motion/react";
import { motionTransition } from "../../motion/tokens";
import { useLayerFrame } from "./useLayerFrame";
import { useCallback, useMemo, useId, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { ChevronLeft, X } from 'lucide-react';
import { t } from '../../i18n';
import { isDesktop } from '../../platform';
import { useReducedMotion } from '../../state/appEnvironment';
import { layers, layerTrigger } from '../../state/layers';
import { notify } from '../../state/connector';
import { type LayerKind, type LayerSide, type LayerRect } from './layerFrame';
import { LayerOwnerContext } from './TransientLayer';
import { IconButton, Notice } from './index';
import { NaturalContentContext, CloseContext, HeaderContext, ActionsContext, PanelStateContext, ViewContext, type View, type PanelState, type NaturalContent } from './LayerPortals';
import { LayerDismissalFooter } from './LayerDismissalFooter';
export { DialogClose, DialogView, DialogActions, PanelHeader, usePanelState, useDialogClose, useDialogFeedback } from './LayerPortals';
import './Dialog.css';

/** Completion respects Keep open and routes results from closed owners to global feedback. */
export function useDialogCompletion(onComplete: () => void | Promise<void>) {
  const layerId = useId();
  const isOpen = () => layers.get().some(layer => layer.id === layerId);
  return { layerId, isOpen, feedback: (message: string, error = false) => { if (!isOpen()) notify(message, error); }, finish: (message = t('activity.completed')) => isOpen()
    ? layers.complete(layerId, onComplete) : notify(message) };
}

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

export type LayerContentHost = { layerId: string; target: HTMLDivElement; render: (props: DialogProps) => ReactNode; ready: () => void };

export function LayerShell({ onContentHost, kind, side = 'center', focusTrigger, onPanelFrame, labelledBy, role = 'dialog', closeLabel, expanded = false, viewKey, contentKey, headerNavigation, onEscapeKeyDown, layerId, open = true, onClose, dirty, busy, onCancel, title, description, children,
  footer, actions, leading, headerDetail, stepBar, headerless, className = '', initialFocus, returnFocus }: DialogProps & { onContentHost?: (host?: LayerContentHost) => void; kind: LayerKind; side?: LayerSide; focusTrigger?: ReturnType<typeof layerTrigger>; onPanelFrame?: (rect: LayerRect | null) => void; labelledBy?: string; role?: 'dialog' | 'region'; closeLabel?: string; expanded?: boolean; viewKey?: string; contentKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void }) {
  const generatedId = useId(), id = layerId ?? generatedId, snapshot = layers.use(), reduced = useReducedMotion();
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [headerCount, setHeaderCount] = useState(0);
  const [headerMounted, setHeaderMounted] = useState(false);
  const headerReady = useCallback(() => setHeaderMounted(true), []);
  const registerHeader = useCallback(() => { setHeaderCount(count => count + 1); return () => setHeaderCount(count => count - 1); }, []);
  const headerContext = useMemo(() => ({ target: headerTarget, register: registerHeader, ready: headerReady }), [headerTarget, registerHeader, headerReady]);
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const [actionCount, setActionCount] = useState(0);
  const registerActions = useCallback(() => { setActionCount(count => count + 1); return () => setActionCount(count => count - 1); }, []);
  const actionsContext = useMemo(() => ({ target: footerTarget, register: registerActions }), [footerTarget, registerActions]);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [entering, setEntering] = useState(true);
  useLayoutEffect(() => {
    if (!node) return;
    setEntering(!reduced);
    if (reduced) { node.style.opacity = '1'; return; }
    node.style.opacity = '0';
    const fade = animate(node, { opacity: 1 }, motionTransition(kind === 'panel' ? 'panel' : 'base'));
    void fade.then(() => setEntering(false));
    return () => fade.stop();
  }, [node, reduced, kind]);
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
  const [naturalBody, setNaturalBody] = useState<NaturalContent>();
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const [readyContent, setReadyContent] = useState<{ key: string; revision: number }>();
  const ready = useCallback(() => setReadyContent(old => ({ key: `${contentKey}:${viewKey}`, revision: (old?.revision ?? 0) + 1 })), [contentKey, viewKey]);
  const { frame, retainedHeight } = useLayerFrame((!onContentHost || readyContent?.key === `${contentKey}:${viewKey}`) && (!headerless || !headerCount || headerMounted) ? contentNode : null, { kind, side, expanded, viewKey: `${contentKey}:${viewKey}`, retainedViewHeight: view ? viewHeight.current : undefined, naturalBody, chromeVersion: `${readyContent?.revision}:${headerCount}:${actionCount}` });
  const contentRef = useCallback((element: HTMLDivElement | null) => setContentNode(element), []);
  const previousContent = useRef(`${contentKey}:${viewKey}:${view?.title}`);
  useLayoutEffect(() => {
    const next = `${contentKey}:${viewKey}:${view?.title}`;
    if (previousContent.current !== next && contentNode && !reduced && !entering) {
      for (const part of contentNode.querySelectorAll<HTMLElement>(':scope > .dialog-header, :scope > .layer-custom-header, :scope > .dialog-body')) void animate(part, { opacity: [.25, 1] }, motionTransition('fast'));
    }
    previousContent.current = next;
  }, [contentKey, viewKey, view, reduced, entering, contentNode]);
  const entryFrame = useRef(frame);
  if (entering || !entryFrame.current) entryFrame.current = frame;
  useLayoutEffect(() => {
    if (!node || !frame) return;
    if (entering || reduced) {
      node.style.top = `${frame.y}px`; node.style.height = `${frame.height}px`;
      return;
    }
    const geometry = animate(node, { top: frame.y, height: frame.height }, motionTransition());
    return () => geometry.stop();
  }, [node, frame, entering, reduced]);
  const focusSource = useRef<HTMLElement | null>(null);
  const self = snapshot.find(layer => layer.id === id);
  const allowed = !open || layers.canOpen(kind, id);
  const dialogs = snapshot.filter(layer => layer.kind === 'dialog');
  const parent = dialogs[dialogs.findIndex(layer => layer.id === id) - 1];
  const portalReady = !!self && (!parent || parent.ready);
  const recessed = !!self && snapshot.at(-1)?.id !== id;
  const depth = Math.max(0, snapshot.filter(layer => layer.kind === 'dialog').findIndex(layer => layer.id === id));
  const stack = layers.stack(id);
  const [panelStates, setPanelStates] = useState<Record<string, PanelState>>({});
  const updatePanelState = useCallback((key: string, state?: PanelState) => setPanelStates(previous => {
    if (!state?.dirty && !state?.busy) {
      if (!previous[key]) return previous;
      const next = { ...previous }; delete next[key]; return next;
    }
    if (previous[key]?.dirty === state.dirty && previous[key]?.busy === state.busy && previous[key]?.onCancel === state.onCancel) return previous;
    return { ...previous, [key]: state };
  }), []);
  const contributions = Object.values(panelStates), running = contributions.filter(state => state.busy);
  dirty ||= contributions.some(state => state.dirty); busy ||= !!running.length;
  onCancel ??= running.length === 1 ? running[0].onCancel : undefined;
  const [exiting, setExiting] = useState(false);
  const onExit = useCallback(async () => {
    if (reduced || !node) return;
    setExiting(true);
    await animate(node, { opacity: 0 }, motionTransition('fast', kind === 'dialog' ? 'exit' : 'enter'));
  }, [node, reduced, kind]);
  const latest = useRef({ onClose, dirty, busy, onCancel, onExit });
  latest.current = { onClose, dirty, busy, onCancel, onExit };
  useLayoutEffect(() => {
    if (!open || !allowed) return;
    focusSource.current = layerTrigger() ?? focusTrigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.open({ id, kind, node: null, trigger: focusSource.current, returnFocus, ...latest.current });
    return () => layers.remove(id);
  }, [open, allowed, id, kind]);
  useLayoutEffect(() => {
    focusSource.current = layerTrigger() ?? focusTrigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.retarget(id, focusSource.current, returnFocus);
  }, [contentKey, viewKey, returnFocus]);
  // Parent Radix effects finish before a child portal mounts, so hideOthers cannot hide the child.
  useEffect(() => {
    if (!node) return;
    layers.ready(id, node);
    return layers.observeOutsidePointer(id);
  }, [node, id]);
  useLayoutEffect(() => {
    if (!node) return;
    const focusFrame = requestAnimationFrame(() => {
      if (layers.top()?.id !== id) return;
      const active = document.activeElement;
      if (!initialFocus && active instanceof HTMLElement && active !== node && node.contains(active) && !active.closest('[hidden], [inert]')) return;
      (initialFocus ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node : node).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [node, id, initialFocus, contentKey, viewKey]);
  const reportFrame = useRef(onPanelFrame); reportFrame.current = onPanelFrame;
  useLayoutEffect(() => {
    if (node && frame) reportFrame.current?.(node.getBoundingClientRect());
  }, [node, frame]);
  useLayoutEffect(() => () => { if (!layers.get().some(layer => layer.kind === "panel" && layer.id !== id)) reportFrame.current?.(null); }, []);
  useLayoutEffect(() => { layers.update(id, { dirty, busy, onClose, onCancel, onExit }); }, [id, dirty, busy, onClose, onCancel, onExit, kind]);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const status = self?.dismissal ?? 'none';
  const close = () => { void layers.close(id); };
  const renderContent = (props: DialogProps) => {
    const { title, children, footer, actions, leading, headerDetail, headerNavigation, description, stepBar, headerless } = props as DialogProps & { headerNavigation?: ReactNode };
    return <LayerOwnerContext.Provider value={id}><NaturalContentContext.Provider value={setNaturalBody}>
        {headerless ? <><h2 className="sr-only" id={`${id}-title`}>{title}</h2><div className="layer-custom-header" ref={setHeaderTarget} hidden={!headerCount} /></> : <header className="dialog-header">
          {view ? <IconButton icon={ChevronLeft} label={t('back')} onClick={back} /> : leading}<h2 id={`${id}-title`} className={kind === 'panel' ? 'panel-title' : undefined}>{view ? <><span className="dialog-breadcrumb">{title}</span><span aria-hidden="true"> / </span>{view.title}</> : title}</h2>{headerNavigation}<div className="actions">{actions}<IconButton icon={X} label={closeLabel ?? t('close')} onClick={close} /></div>
        </header>}
        {!view && headerDetail}
        {description && <div className="dialog-description" id={`${id}-description`}>{description}</div>}
        {!view && stepBar}
        <HeaderContext.Provider value={headerContext}><PanelStateContext.Provider value={updatePanelState}><CloseContext.Provider value={{ id, busy, close, feedback: (message, error) => setFeedback({ message, error }) }}>
        <ViewContext.Provider value={viewContext}>
        <ActionsContext.Provider value={actionsContext}>
          <div className="dialog-body dialog-view-stack" inert={status !== 'none' || undefined}>
            <div key={contentKey} className="dialog-swap" hidden={!!view} inert={!!view || undefined}>{feedback && <Notice tone={feedback.error ? "danger" : "success"}>{feedback.message}</Notice>}{children}</div>
            <div className="dialog-swap" ref={setViewBody} hidden={!view} inert={!view || undefined} tabIndex={-1} />
          </div>
        </ActionsContext.Provider>
        <footer ref={setFooterTarget} className="dialog-footer" hidden={!!view || status !== 'none' || !footer && !actionCount}>{footer}</footer>
        <footer ref={setViewFooter} className="dialog-footer" hidden={!view || status !== 'none'} />
        </ViewContext.Provider>
        </CloseContext.Provider></PanelStateContext.Provider></HeaderContext.Provider>
        <LayerDismissalFooter id={id} status={status} cancellable={!!onCancel} close={close} />
    </NaturalContentContext.Provider></LayerOwnerContext.Provider>;
  };
  const renderRef = useRef(renderContent); renderRef.current = renderContent;
  const render = useCallback((props: DialogProps) => renderRef.current(props), []);
  const contentHost = useMemo(() => contentNode ? { layerId: id, target: contentNode, render, ready } : undefined,
    [contentNode, render, ready, view, status, headerTarget, headerCount, footerTarget, actionCount, viewBody, viewFooter, feedback, busy]);
  useLayoutEffect(() => { onContentHost?.(contentHost); return () => onContentHost?.(); }, [onContentHost, contentHost]);
  return <D.Root modal={kind === 'dialog'} open={open && allowed && portalReady} onOpenChange={next => { if (!next) void layers.close(id); }}>
    <LayerOwnerContext.Provider value={id}>
    <D.Portal>
      {kind === 'dialog' && snapshot.some(layer => layer.id !== id && snapshot.indexOf(layer) < snapshot.findIndex(item => item.id === id)) && <D.Overlay className="layer-scrim" style={{ zIndex: stack.scrim }} />}
      <D.Content asChild role={role} ref={setNode} className={`dialog ${kind === 'panel' ? `layer-panel ${side !== 'center' ? 'node-panel' : ''}` : 'layer-dialog'} ${headerless ? 'headerless' : ''} ${className}`}
        data-layer-entering={entering || undefined} data-layer-frame-top={frame?.y} data-layer-frame-height={frame?.height}
        data-layer-kind={kind} data-layer-side={kind === 'panel' ? side : undefined} data-panel-depth={depth + 1} inert={recessed || undefined} data-exiting={exiting || undefined}
        {...{ "aria-labelledby": labelledBy ?? `${id}-title` }}
        aria-describedby={description ? `${id}-description` : undefined}
        style={{ opacity: reduced ? 1 : 0, top: entryFrame.current?.y, height: entryFrame.current?.height, left: frame?.x, width: frame?.width ?? `var(--layer-${kind === 'panel' && side === 'center' ? 'xl' : 'm'})`, maxHeight: frame?.maxHeight,
          visibility: frame ? undefined : 'hidden', zIndex: kind === 'panel' ? stack.panel : stack.dialog,
          '--layer-retained-height': `${retainedHeight}px`, '--layer-content-cap': `calc(100vh - var(--layer-${isDesktop ? 'top-desktop' : 'top-browser'}) - var(--layer-side-margin))` } as CSSProperties}
        onOpenAutoFocus={event => {
          event.preventDefault();
          const host = event.target instanceof HTMLElement ? event.target : node;
          const target = initialFocus ? host?.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) : undefined;
          (target ?? host)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={event => { event.preventDefault(); layers.restoreFocus({ trigger: focusSource.current, returnFocus }); }}
        onEscapeKeyDown={event => { if (layers.top()?.id !== id) return; if (status === 'none') onEscapeKeyDown?.(event); if (event.defaultPrevented) return; event.preventDefault(); if (view && status === 'none') back(); else layers.dismiss(id); }}
        onPointerDownOutside={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}>
        <div>
        <div className="layer-content" data-natural-body={!!naturalBody || undefined} ref={contentRef}>
        <D.Title hidden />
        {onContentHost ? null : renderContent({ onClose, title, children, footer, actions, leading, headerDetail, description, stepBar, headerless, headerNavigation } as DialogProps)}
        </div></div>
      </D.Content>
    </D.Portal>
    </LayerOwnerContext.Provider>
  </D.Root>;
}

export default function Dialog(props: DialogProps) { return <LayerShell {...props} kind="dialog" />; }

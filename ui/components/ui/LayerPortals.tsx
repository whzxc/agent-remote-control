import { createContext, useContext, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dialog as D, Slot } from 'radix-ui';
import { layers } from '../../state/layers';
import { notify } from '../../state/connector';
import type { DialogProps } from './Dialog';
export const CloseContext = createContext<{ id: string; busy?: boolean; close: () => void; feedback: (message: string, error: boolean) => void } | null>(null);
export function useDialogClose() { return useContext(CloseContext)?.close; }
export function useDialogFeedback() {
  const context = useContext(CloseContext);
  return (message: string, error = false) => {
    if (context && layers.get().some(layer => layer.id === context.id)) context.feedback(message, error);
    else notify(message, error);
  };
}
export function DialogClose({ asChild, onClick, type = 'button', ...props }: ComponentProps<typeof D.Close>) {
  const context = useContext(CloseContext);
  const Control = asChild ? Slot.Root : 'button';
  return <Control {...props} type={type} onClick={event => {
    onClick?.(event);
    if (!event.defaultPrevented) context?.close();
  }} />;
}


export type PanelState = { dirty?: boolean; busy?: boolean; onCancel?: DialogProps['onCancel'] };
export const PanelStateContext = createContext<((id: string, state?: PanelState) => void) | null>(null);
/** Register draft and work state with the owning workspace shell. */
export function usePanelState({ dirty = false, busy = false, onCancel }: PanelState) {
  const update = useContext(PanelStateContext), id = useId();
  useLayoutEffect(() => { update?.(id, { dirty, busy, onCancel }); }, [update, id, dirty, busy, onCancel]);
  useLayoutEffect(() => () => update?.(id), [update, id]);
}

export type View = { title: string; back: () => void; trigger: HTMLElement | null };
export const ViewContext = createContext<{
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

export const HeaderContext = createContext<{ target: HTMLElement | null; register: () => () => void; ready: () => void } | null>(null);
/** Keep feature-owned node headers outside the scrolling body. */
export function PanelHeader({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const context = useContext(HeaderContext);
  useLayoutEffect(() => active ? context?.register() : undefined, [active, context?.register]);
  useLayoutEffect(() => { if (active && context?.target) context.ready(); }, [active, context?.target, context?.ready]);
  return active ? context ? context.target && createPortal(children, context.target) : children : null;
}

export const ActionsContext = createContext<{ target: HTMLElement | null; register: () => () => void } | null>(null);

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


export type NaturalContent = { node: HTMLElement; initialHeight: number; flexibleFooter: boolean; resetHeight: boolean };
export const NaturalContentContext = createContext<((content?: NaturalContent) => void) | null>(null);
/** Scroll views expose intrinsic content separately from their clipped viewport. */
export function useLayerNaturalContent(ref: { current: HTMLElement | null }, active = true, {
  version = '', flexibleFooter = false, resetHeight = false,
}: { version?: string; flexibleFooter?: boolean; resetHeight?: boolean } = {}) {
  const register = useContext(NaturalContentContext);
  useLayoutEffect(() => {
    if (ref.current && active) register?.({ node: ref.current, initialHeight: ref.current.getBoundingClientRect().height, flexibleFooter, resetHeight });
    return () => register?.();
  }, [register, ref, active, version, flexibleFooter, resetHeight]);
}

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { consumeOutsidePointer, layers, layerTrigger } from '../state/layers';
import { t } from '../i18n';
import { IconButton } from './ui';

/** Existing workspace geometry is retained until the workspace migration segment. */
export default function WorkspacePanel({ title, children, onClose, actions, footer, width = 720,
  className = '', headerless, initialFocus, returnFocus, headerNavigation, onEscapeKeyDown }: {
  title: ReactNode; children: ReactNode; onClose: () => void | Promise<void>;
  actions?: ReactNode; footer?: ReactNode; width?: number; className?: string; headerless?: boolean;
  initialFocus?: string; returnFocus?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const id = useId(), snapshot = layers.use();
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  const recessed = !!node && snapshot.at(-1)?.node !== node;
  useLayoutEffect(() => {
    if (!node) return;
    trigger.current = layerTrigger()?.element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    layers.open({ id, node, kind: 'panel', trigger: trigger.current, returnFocus, onClose: () => closeRef.current() });
    return () => layers.remove(id);
  }, [id, node, returnFocus]);
  useLayoutEffect(() => {
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (layers.top()?.id === id) (initialFocus ? node.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? node : node).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, node, initialFocus]);
  return <D.Root modal={false} open onOpenChange={next => { if (!next) void layers.close(id); }}><D.Portal>
    <D.Content ref={setNode} className={`dialog elastic-panel workspace-panel ${headerless ? 'headerless' : ''} ${className}`}
      inert={recessed || undefined} data-panel-depth="1" aria-describedby={undefined}
      style={{ '--preferred-width': `${width}px`, transform: 'translate(-50%, -50%)', zIndex: 101 } as CSSProperties}
      onOpenAutoFocus={event => { event.preventDefault(); const host = event.target as HTMLElement; (initialFocus ? host.querySelector<HTMLElement>(`#${CSS.escape(initialFocus)}`) ?? host : host).focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); layers.restoreFocus({ trigger: trigger.current, returnFocus }); }}
      onEscapeKeyDown={event => { onEscapeKeyDown?.(event); if (event.defaultPrevented) return; event.preventDefault(); layers.dismiss(id); }}
      onPointerDownOutside={event => {
        event.preventDefault();
        if (event.detail.originalEvent.button !== 0) return;
        consumeOutsidePointer(event.detail.originalEvent); layers.dismiss(id);
      }} onInteractOutside={event => event.preventDefault()}>
      <div className="elastic-panel-content">
        {headerless ? <D.Title className="sr-only">{title}</D.Title> : <header className="dialog-header"><D.Title>{title}</D.Title>{headerNavigation}
          <div className="actions">{actions}<IconButton icon={X} label={t('close')} onClick={() => void layers.close(id)} /></div></header>}
        <div className="dialog-body">{children}</div>{footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </D.Content>
  </D.Portal></D.Root>;
}

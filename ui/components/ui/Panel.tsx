import type { layerTrigger } from "../../state/layers";
import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { createStore } from '../../state/store';
import { layers } from '../../state/layers';
import { panelSlot } from './layerFrame';
import { Maximize2, Minimize2 } from 'lucide-react';
import { t } from '../../i18n';
import { IconButton } from './index';
import type { LayerSide, LayerRect } from './layerFrame';
import { LayerShell, DialogActions, type DialogProps } from './Dialog';
export { usePanelState, LayerHeader as PanelHeader } from './Dialog';

export type PanelProps = DialogProps & {
  side?: LayerSide; focusTrigger?: ReturnType<typeof layerTrigger>; labelledBy?: string; onPanelFrame?: (rect: LayerRect | null) => void; role?: 'dialog' | 'region'; expanded?: boolean; onToggleWidth?: () => void;
  viewKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
};
/** Shared nonmodal shell for center workspaces and mirrored node slots. */
type Request = { id: string; props: PanelProps };
function panelRegistry() {
  const state = createStore<Request | undefined>(undefined), owners = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return { ...state,
    update(next: Request) {
      clearTimeout(timer); owners.add(next.id);
      const old = state.get();
      if (old && old.id !== next.id && owners.has(old.id)) void old.props.onClose();
      layers.endSwitch(); state.set(next);
    },
    release(id: string) {
      owners.delete(id);
      queueMicrotask(() => {
        if (state.get()?.id !== id || owners.has(id)) return;
        const clear = () => { if (state.get()?.id === id && !owners.has(id)) state.set(undefined); };
        if (layers.isSwitching()) timer = setTimeout(clear, 250); else clear();
      });
    },
  };
}
const PanelRegistry = createContext<ReturnType<typeof panelRegistry> | null>(null);
/** One persistent shell per physical slot; owners provide content and lifecycle callbacks. */
export function PanelProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(panelRegistry, []);
  return <PanelRegistry.Provider value={registry}>{children}<PanelHost registry={registry} /></PanelRegistry.Provider>;
}
function PanelHost({ registry }: { registry: ReturnType<typeof panelRegistry> }) {
  const current = useSyncExternalStore(registry.subscribe, registry.get, registry.get);
  const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }));
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => { const resize = () => setViewport({ width: innerWidth, height: innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const props = current?.props, side = props?.side ?? 'center';
  const slot = panelSlot(side, viewport);
  return <AnimatePresence mode="sync">{current && <PanelShell key={slot} {...props!} contentKey={current.id}
    expanded={side === 'center' ? wide : props?.expanded}
    onToggleWidth={props?.onToggleWidth ? side === 'center' ? () => setWide(value => !value) : props.onToggleWidth : undefined} />}</AnimatePresence>;
}
export default function Panel(props: PanelProps) {
  const registry = useContext(PanelRegistry), id = useId();
  const latest = useRef(props); latest.current = props;
  useLayoutEffect(() => { registry?.update({ id, props: latest.current }); });
  useLayoutEffect(() => () => registry?.release(id), [registry, id]);
  return registry ? null : <PanelShell {...props} />;
}
function PanelShell({ onToggleWidth, expanded, actions, ...props }: PanelProps & { contentKey?: string }) {
  return <LayerShell {...props} kind="panel" closeLabel={props.role === "region" ? t("backToHome") : undefined} expanded={expanded} actions={<>{actions}{onToggleWidth &&
    <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')}
      aria-pressed={!!expanded} onClick={onToggleWidth} />}</>} />;
}
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogActions className={`panel-footer-content ${className ?? ""}`}>{children}</DialogActions>;
}

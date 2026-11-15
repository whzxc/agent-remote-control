import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { type layerTrigger } from '../../state/layers';
import { t } from '../../i18n';
import { IconButton } from './index';
import { type LayerSize, type LayerRect } from './layerFrame';
import { LayerShell, DialogActions, type DialogProps, type LayerContentHost } from './Dialog';
export { usePanelState, PanelHeader } from './Dialog';

export type PanelProps = DialogProps & {
  size?: LayerSize; focusTrigger?: ReturnType<typeof layerTrigger>; labelledBy?: string; onPanelFrame?: (rect: LayerRect | null) => void;
  role?: 'dialog' | 'region'; expanded?: boolean; onToggleWidth?: () => void;
  viewKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
};
export type Slot = 'center';
export type Request = { id: string; slot: Slot; alive: { current: boolean }; config: PanelProps; route?: RouteControl | null };
export type Host = LayerContentHost & { id: string };
export type Slots = Partial<Record<Slot, Request>>;
export const PanelSlots = createContext<{
  request: (id: string, key?: string) => void; update: (request: Request) => void; release: (id: string) => void;
  hosts: Partial<Record<Slot, Host>>;
  wide: boolean; toggleWide: () => void;
} | null>(null);

type RouteControl = { id: string; key: string; active: boolean; commit: () => void; retire: () => void };
const PanelRouteContext = createContext<RouteControl | null>(null);
/** Retain the previous owner while its replacement prepares, without moving its React subtree. */
export function PanelRoute<T>({ value, identity, children }: {
  value: T | undefined; identity: (value: T) => string; children: (value: T, active: boolean) => ReactNode;
}) {
  const id = useId(), slots = useContext(PanelSlots), key = value === undefined ? undefined : identity(value);
  const committed = useRef<string | undefined>(undefined);
  const [entries, setEntries] = useState<{ key: string; value: T }[]>(value === undefined ? [] : [{ key: key!, value }]);
  useLayoutEffect(() => {
    slots?.request(id, key);
    setEntries(old => {
      const retained = old.filter(entry => entry.key === committed.current);
      if (value === undefined) return retained.length === old.length ? old : retained;
      if (old.find(entry => entry.key === key)?.value === value && old.every(entry => entry.key === key || entry.key === committed.current)) return old;
      return [...retained.filter(entry => entry.key !== key), { key: key!, value }];
    });
  }, [slots?.request, id, key, value]);
  useLayoutEffect(() => () => slots?.request(id), [slots?.request, id]);
  return entries.map(entry => <PanelRouteOwner key={entry.key} id={id} entryKey={entry.key} active={entry.key === key}
    commit={() => { committed.current = entry.key; setEntries(old => old.length > 1 ? old.filter(item => item.key === entry.key) : old); }}
    retire={() => { if (committed.current === entry.key) committed.current = undefined; setEntries(old => old.some(item => item.key === entry.key) ? old.filter(item => item.key !== entry.key) : old); }}>
    {children(entry.value, entry.key === key)}
  </PanelRouteOwner>);
}
function PanelRouteOwner({ id, entryKey: key, active, commit, retire, children }: {
  id: string; entryKey: string; active: boolean; commit: () => void; retire: () => void; children: ReactNode;
}) {
  const value = useMemo(() => ({ id, key, active, commit, retire }), [id, key, active, commit, retire]);
  return <PanelRouteContext.Provider value={value}>{children}</PanelRouteContext.Provider>;
}
export default function Panel(props: PanelProps) {
  const route = useContext(PanelRouteContext), routeRef = useRef(route); routeRef.current = route;
  const slots = useContext(PanelSlots), id = useId(), alive = useRef(true);
  const latest = useRef(props); latest.current = props;
  const size = props.size ?? 'xl', slot = 'center' as const;
  const config = {
    snapshotKey: props.snapshotKey, size, title: '', children: null, role: props.role, description: props.description ? true : undefined, closeLabel: props.role === 'region' ? t('backToHome') : undefined,
    focusTrigger: props.focusTrigger, labelledBy: props.labelledBy, headerless: props.headerless, className: props.className,
    initialFocus: props.initialFocus, returnFocus: props.returnFocus, viewKey: props.viewKey, dirty: props.dirty, busy: props.busy,
    expanded: size === 'xl' && slots ? slots.wide : props.expanded,
  };
  const close = useCallback(() => {
    const owner = routeRef.current;
    const result = alive.current && (!owner || owner.active) ? latest.current.onClose() : undefined;
    owner?.retire();
    return result;
  }, []);
  const cancel = useCallback(() => latest.current.onCancel?.(), []);
  const escape = useCallback((event: KeyboardEvent) => latest.current.onEscapeKeyDown?.(event), []);
  const frame = useCallback((rect: LayerRect | null) => latest.current.onPanelFrame?.(rect), []);
  useLayoutEffect(() => {
    slots?.update({ id, slot, alive, route, config: { ...config, onClose: close, onCancel: props.onCancel ? cancel : undefined, onEscapeKeyDown: escape, onPanelFrame: frame } });
    if (route?.active) route.commit();
  }, [slots?.update, id, slot, ...Object.values(config), !!props.onCancel, route?.id, route?.key, route?.active, close, cancel, escape, frame]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; slots?.release(id); }; }, [slots?.release, id]);
  const expanded = config.expanded, toggle = size === 'xl' && slots ? slots.toggleWide : props.onToggleWidth;
  const content = { ...props, actions: <>{props.actions}{props.onToggleWidth && <IconButton icon={expanded ? Minimize2 : Maximize2}
    label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')} aria-pressed={!!expanded} onClick={toggle} />}</> };
  const host = slots?.hosts[slot];
  useLayoutEffect(() => { if (host?.id === id) host.ready(); }, [host, id]);
  if (slots) return host?.id === id ? createPortal(host.render(content), host.target) : null;
  return <LayerShell {...content} onClose={close} closeLabel={config.closeLabel} kind="panel" />;
}
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogActions className={`panel-footer-content ${className ?? ''}`}>{children}</DialogActions>;
}

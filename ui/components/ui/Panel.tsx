import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { layers, type layerTrigger } from '../../state/layers';
import { t } from '../../i18n';
import { IconButton } from './index';
import { panelSlot, type LayerSide, type LayerRect } from './layerFrame';
import { LayerShell, DialogActions, type DialogProps, type LayerContentHost } from './Dialog';
export { usePanelState, PanelHeader } from './Dialog';

type PanelProps = DialogProps & {
  side?: LayerSide; focusTrigger?: ReturnType<typeof layerTrigger>; labelledBy?: string; onPanelFrame?: (rect: LayerRect | null) => void;
  role?: 'dialog' | 'region'; expanded?: boolean; onToggleWidth?: () => void;
  viewKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
};
type Slot = ReturnType<typeof panelSlot>;
type Request = { id: string; slot: Slot; alive: { current: boolean }; config: PanelProps; route?: RouteControl | null };
type Host = LayerContentHost & { id: string };
type Slots = Partial<Record<Slot, Request>>;
const PanelSlots = createContext<{
  request: (id: string, key?: string) => void; update: (request: Request) => void; release: (id: string) => void;
  hosts: Partial<Record<Slot, Host>>; viewport: { width: number; height: number };
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

/** Explicit physical slots own shells; feature content remains in its original React tree. */
export function PanelProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({}), current = useRef<Slots>({});
  const [hosts, setHosts] = useState<Partial<Record<Slot, Host>>>({});
  const [desired, setDesired] = useState<Record<string, string | undefined>>({});
  const stack = layers.use();
  const request = useCallback((id: string, key?: string) => setDesired(old => old[id] === key ? old : { ...old, [id]: key }), []);
  useLayoutEffect(() => {
    if (Object.values(desired).some(Boolean) || layers.top()?.kind === 'dialog') return;
    for (const [slot, item] of Object.entries(current.current)) {
      const host = hosts[slot as Slot];
      if (item.route && host?.id === item.id && stack.some(layer => layer.id === host.layerId)) void layers.close(host.layerId);
    }
  }, [desired, stack, hosts]);
  const [wide, setWide] = useState(false);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useLayoutEffect(() => { const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const update = useCallback((request: Request) => {
    const old = current.current[request.slot];
    if (old && old.id !== request.id && old.alive.current) void old.config.onClose();
    const retained = Object.fromEntries(Object.entries(current.current).filter(([slot, item]) => item.id !== request.id || slot === request.slot));
    const next = { ...retained, [request.slot]: request }; current.current = next; setSlots(next);
  }, []);
  const release = useCallback((id: string) => {
    const next = Object.fromEntries(Object.entries(current.current).filter(([, request]) => request.id !== id));
    current.current = next; setSlots(next);
  }, []);
  const registerHost = useCallback((slot: Slot, id: string, host?: LayerContentHost) => setHosts(old => {
    if (!host && old[slot]?.id !== id) return old;
    return { ...old, [slot]: host ? { ...host, id } : undefined };
  }), []);
  const toggleWide = useCallback(() => setWide(value => !value), []);
  const value = useMemo(() => ({ request, update, release, hosts, viewport, wide, toggleWide }), [request, update, release, hosts, viewport, wide, toggleWide]);
  return <PanelSlots.Provider value={value}>{children}{Object.entries(slots).map(([slot, request]) =>
    <PanelSlotHost key={slot} slot={slot as Slot} request={request} register={registerHost} />)}</PanelSlots.Provider>;
}
function PanelSlotHost({ slot, request, register }: { slot: Slot; request: Request; register: (slot: Slot, id: string, host?: LayerContentHost) => void }) {
  const connect = useCallback((host?: LayerContentHost) => register(slot, request.id, host), [register, slot, request.id]);
  return <LayerShell {...request.config} contentKey={request.id} kind="panel" onContentHost={connect} />;
}
export default function Panel(props: PanelProps) {
  const route = useContext(PanelRouteContext), routeRef = useRef(route); routeRef.current = route;
  const slots = useContext(PanelSlots), id = useId(), alive = useRef(true);
  const latest = useRef(props); latest.current = props;
  const side = props.side ?? 'center', slot = panelSlot(side, slots?.viewport ?? { width: innerWidth, height: innerHeight });
  const config = {
    side, title: '', children: null, role: props.role, description: props.description ? true : undefined, closeLabel: props.role === 'region' ? t('backToHome') : undefined,
    focusTrigger: props.focusTrigger, labelledBy: props.labelledBy, headerless: props.headerless, className: props.className,
    initialFocus: props.initialFocus, returnFocus: props.returnFocus, viewKey: props.viewKey, dirty: props.dirty, busy: props.busy,
    expanded: side === 'center' && slots ? slots.wide : props.expanded,
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
  const expanded = config.expanded, toggle = side === 'center' && slots ? slots.toggleWide : props.onToggleWidth;
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

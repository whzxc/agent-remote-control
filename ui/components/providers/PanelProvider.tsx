import { PanelSlots, type Slots, type Host, type Slot, type Request } from '../ui/Panel';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { layers } from '../../state/layers';

import { LayerShell, type LayerContentHost } from '../ui/Dialog';
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
  const value = useMemo(() => ({ request, update, release, hosts, wide, toggleWide }), [request, update, release, hosts, wide, toggleWide]);
  return <PanelSlots.Provider value={value}>{children}{Object.entries(slots).map(([slot, request]) =>
    <PanelSlotHost key={slot} slot={slot as Slot} request={request} register={registerHost} />)}</PanelSlots.Provider>;
}

function PanelSlotHost({ slot, request, register }: { slot: Slot; request: Request; register: (slot: Slot, id: string, host?: LayerContentHost) => void }) {
  const connect = useCallback((host?: LayerContentHost) => register(slot, request.id, host), [register, slot, request.id]);
  return <LayerShell {...request.config} contentKey={request.id} kind="panel" onContentHost={connect} />;
}

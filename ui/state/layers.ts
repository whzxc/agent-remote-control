import { useSyncExternalStore } from 'react';
import type { LayerKind } from '../components/ui/layerFrame';

export type Dismissal = 'none' | 'discard' | 'running';
type Layer = {
  id: string;
  kind: LayerKind;
  node: HTMLElement | null;
  ready: boolean;
  trigger: HTMLElement | null;
  returnFocus?: string;
  dirty?: boolean;
  busy?: boolean;
  onClose: () => void | Promise<void>;
  onExit?: () => Promise<void>;
  onCancel?: () => void | boolean | Promise<void | boolean>;
  dismissal: Dismissal;
  keepAfterWork: boolean;
};
const switcherSelector = '[data-workspace-switcher], [data-layer-switcher]';
type LayerInput = Omit<Layer, 'dismissal' | 'keepAfterWork' | 'ready'>;

/** The registry owns dismissal and focus across portaled dialogs and retained panels. */
export function createLayerStore() {
  let current: Layer[] = [];
  const subscribers = new Set<() => void>();
  const publish = (next: Layer[]) => { current = next; subscribers.forEach(listener => listener()); };
  const get = () => current;
  const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
  const top = () => current.at(-1);
  const contains = (id: string, target: EventTarget | null) => target instanceof Element
    && (current.find(layer => layer.id === id)?.node?.contains(target)
      || target.closest<HTMLElement>('[data-layer-owner]')?.dataset.layerOwner === id);
  const remove = (id: string) => { if (current.some(layer => layer.id === id)) publish(current.filter(layer => layer.id !== id)); };
  const closing = new Set<string>();
  let pendingSwitch: { id: string; open: () => void; toggle: boolean } | undefined;
  const finishClose = async (id: string, complete?: () => void | Promise<void>) => {
    const layer = current.find(item => item.id === id);
    if (!layer || closing.has(id)) return;
    closing.add(id);
    try {
      const pending = pendingSwitch?.id === id ? pendingSwitch : undefined;
      if (pending) pendingSwitch = undefined;
      if (pending && !pending.toggle) { pending.open(); return; }
      await layer.onExit?.();
      await (complete ?? layer.onClose)();
    }
    finally { closing.delete(id); }
  };
  const setDismissal = (id: string, dismissal: Dismissal) => {
    publish(current.map(layer => layer.id === id ? { ...layer, dismissal } : layer));
  };
  const close = (id: string) => {
    if (current.find(layer => layer.id === id)?.busy) { setDismissal(id, 'running'); return Promise.resolve(); }
    return finishClose(id);
  };
  const canOpen = (kind: LayerKind, id: string) => {
    if (kind !== 'dialog' || current.some(layer => layer.id === id) || current.filter(layer => layer.kind === 'dialog').length < 2) return true;
    const error = new Error(`Cannot open dialog ${id}: at most two dialogs may be stacked. Use an in-dialog view for nested content.`);
    if (!import.meta.env?.PROD) throw error;
    console.error(error);
    return false;
  };
  const dismiss = (id: string) => {
    const layer = top();
    if (layer?.id !== id) return;
    if (layer.busy) setDismissal(id, 'running');
    else if (layer.dirty) setDismissal(id, 'discard');
    else void close(id);
  };
  return {
    get, subscribe, top, remove, close, dismiss, contains,
    stack(id?: string) {
      const depth = current.filter(layer => layer.kind === 'dialog').findIndex(layer => layer.id === id);
      const scrim = 201 + Math.max(0, depth) * 10;
      return { panel: 101, switcher: 110, scrim, dialog: scrim + 1, transient: depth < 0 ? 120 : scrim + 2 };
    },
    observeOutsidePointer(id: string) {
      const handle = (event: PointerEvent) => {
        const layer = top(), target = event.target;
        if (layer?.id !== id || !layer.node || event.button !== 0 || !(target instanceof Element)) return;
        if (contains(id, target) || layer.kind === 'panel' && target.closest(switcherSelector)) return;
        consumeOutsidePointer(event);
        dismiss(id);
      };
      document.addEventListener('pointerdown', handle, true);
      return () => document.removeEventListener('pointerdown', handle, true);
    },
    async complete(id: string, onComplete: () => void | Promise<void>) {
      const layer = current.find(item => item.id === id);
      if (layer?.keepAfterWork) return;
      if (layer) await finishClose(id, onComplete);
      else await onComplete();
    },
    use: () => useSyncExternalStore(subscribe, get, get),
    canOpen,
    switchPanel(open: () => void, toggle = false) {
      if (top()?.kind === 'dialog') return;
      const panel = current.find(layer => layer.kind === 'panel');
      if (!panel) { open(); return; }
      if (panel.busy || panel.dirty) { pendingSwitch = { id: panel.id, open, toggle }; dismiss(panel.id); }
      else if (toggle) void close(panel.id); else open();
    },
    open(layer: LayerInput) {
      if (current.some(item => item.id === layer.id)) return;
      if (!canOpen(layer.kind, layer.id)) return;
      if (layer.kind === 'panel') {
        const previous = current.filter(item => item.kind === 'panel');
        pendingSwitch = undefined;
        publish([{ ...layer, dismissal: 'none', keepAfterWork: false, ready: !!layer.node }, ...current.filter(item => item.kind !== 'panel')]);
        previous.forEach(item => { void (async () => { await item.onExit?.(); await item.onClose(); })(); });
      } else publish([...current, { ...layer, dismissal: 'none', keepAfterWork: false, ready: !!layer.node }]);
    },
    retarget(id: string, trigger: HTMLElement | null, returnFocus?: string) {
      const layer = current.find(item => item.id === id);
      if (layer) { layer.trigger = trigger; layer.returnFocus = returnFocus; }
    },
    ready(id: string, node: HTMLElement) {
      const layer = current.find(item => item.id === id);
      if (!layer || layer.ready && layer.node === node) return;
      publish(current.map(item => item.id === id ? { ...item, node, ready: true } : item));
    },
    update(id: string, next: Pick<Layer, 'dirty' | 'busy' | 'onClose' | 'onCancel' | 'onExit'>) {
      const previous = current.find(layer => layer.id === id);
      if (!previous) return;
      previous.onClose = next.onClose;
      previous.onCancel = next.onCancel;
      previous.onExit = next.onExit;
      if (previous.dirty === next.dirty && previous.busy === next.busy) return;
      const finished = previous.busy && !next.busy && previous.dismissal === 'running';
      const dismissal = previous.dismissal === 'discard' && !next.dirty ? 'none' : previous.dismissal;
      publish(current.map(layer => layer.id === id ? { ...layer, ...next, dismissal, keepAfterWork: !previous.busy && next.busy ? false : layer.keepAfterWork } : layer));
      if (finished) { setDismissal(id, 'none'); void finishClose(id); }
    },
    keepOpen(id: string) {
      if (top()?.id !== id) return;
      if (pendingSwitch?.id === id) pendingSwitch = undefined;
      publish(current.map(layer => layer.id === id ? { ...layer, dismissal: 'none', keepAfterWork: layer.dismissal === 'running' } : layer));
    },
    async stopAndClose(id: string) {
      const layer = top();
      if (layer?.id !== id || !layer.onCancel) return;
      setDismissal(id, 'none');
      if (await layer.onCancel() === false) return;
      await finishClose(id);
    },
    restoreFocus(layer: Pick<Layer, 'trigger' | 'returnFocus'>) {
      requestAnimationFrame(() => {
        const activeLayer = top();
        const active = document.activeElement;
        if (activeLayer && active instanceof Element && activeLayer.node?.contains(active) && active !== activeLayer.node) return;
        // A subsequent user action may already have focused its trigger before this deferred restore.
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
        // A handoff may focus a Radix transient outside the layer registry.
        const owner = active?.closest('[role="dialog"]');
        if (owner && active !== owner && owner.isConnected) return;
        const fallbacks = layer.returnFocus ? Array.from(document.querySelectorAll<HTMLElement>(layer.returnFocus)) : [];
        for (const target of [layer.trigger, activeLayer?.node, ...fallbacks]) {
          if (!target?.isConnected || target === document.body || target.closest('[inert], [hidden]') || target.matches(':disabled')) continue;
          const style = getComputedStyle(target);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          target.focus({ preventScroll: true });
          if (document.activeElement === target) break;
        }
      });
    },
  };
}
export const layers = createLayerStore();

let clickTrigger: HTMLElement | undefined;
let triggerTimer: ReturnType<typeof setTimeout> | undefined;
export function captureLayerTrigger(target: EventTarget | null) {
  clearTimeout(triggerTimer);
  const element = target instanceof Element ? target.closest<HTMLElement>('button, a, [role="button"], [data-panel-anchor]') : null;
  clickTrigger = element ?? undefined;
  triggerTimer = setTimeout(() => { clickTrigger = undefined; }, 200);
}
export function layerTrigger() { return clickTrigger; }

/** Consume the release and click even when a clean layer unmounts on pointer down. */
export function consumeOutsidePointer(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  const block = (click: Event) => { click.preventDefault(); click.stopImmediatePropagation(); };
  const cleanup = () => { document.removeEventListener('click', block, true); document.removeEventListener('pointerup', release, true); };
  const release = () => { setTimeout(cleanup, 0); };
  document.addEventListener('click', block, true);
  document.addEventListener('pointerup', release, { capture: true, once: true });
  setTimeout(cleanup, 1000);
}

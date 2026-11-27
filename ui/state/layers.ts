import { useSyncExternalStore } from 'react';

export type LayerKind = 'panel' | 'dialog';
export type LayerSize = 'm' | 'xl';
export type LayerRect = { x: number; y: number; width: number; height: number };
export type Dismissal = 'none' | 'discard' | 'running';

type Layer = {
  id: string;
  kind: LayerKind;
  dirty?: boolean;
  busy?: boolean;
  onClose: () => void | Promise<void>;
  onCancel?: () => void | boolean | Promise<void | boolean>;
  dismissal: Dismissal;
  keepAfterWork: boolean;
};

type LayerInput = Omit<Layer, 'dismissal' | 'keepAfterWork'>;

const transientSelector = [
  '[role="listbox"]',
  '[role="menu"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="menu-popup"]',
].join(', ');

export function isTransientTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(transientSelector));
}

export function hasOpenTransient(): boolean {
  if (typeof document === 'undefined') return false;
  for (const node of document.querySelectorAll(transientSelector)) {
    if (
      node.closest('[hidden]') ||
      node.hasAttribute('data-closed') ||
      node.getAttribute('data-state') === 'closed'
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function isFocusableTarget(target: HTMLElement | null | undefined): target is HTMLElement {
  if (!target?.isConnected || target === document.body) return false;
  if (target.closest('[inert], [hidden]') || target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  const style = getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function resolveReturnFocus(
  trigger: HTMLElement | null | undefined,
  returnFocus?: string,
  fallback?: HTMLElement | null,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const selectorTargets = returnFocus ? Array.from(document.querySelectorAll<HTMLElement>(returnFocus)) : [];
  const mainTargets = Array.from(document.querySelectorAll<HTMLElement>('main[tabindex="-1"]'));
  for (const candidate of [trigger, ...selectorTargets, fallback, ...mainTargets]) {
    if (isFocusableTarget(candidate)) return candidate;
  }
  return null;
}

/** Minimal active-layer coordinator for workspace switching, dirty/busy dismissal, and 2-dialog stack cap. */
export function createLayerStore() {
  let current: Layer[] = [];
  const subscribers = new Set<() => void>();
  const publish = (next: Layer[]) => {
    current = next;
    subscribers.forEach(listener => listener());
  };
  const get = () => current;
  const subscribe = (listener: () => void) => {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  };
  const top = () => current.at(-1);
  const closing = new Set<string>();
  let pendingSwitch: { id: string; open: () => void; toggle: boolean; trigger: HTMLElement | null } | undefined;
  let switchTrigger: HTMLElement | null | undefined;

  const setDismissal = (id: string, dismissal: Dismissal) => {
    publish(current.map(layer => layer.id === id ? { ...layer, dismissal } : layer));
  };

  const finishClose = async (id: string, complete?: () => void | Promise<void>) => {
    const layer = current.find(item => item.id === id);
    if (!layer || closing.has(id)) return;
    closing.add(id);
    try {
      const pending = pendingSwitch?.id === id ? pendingSwitch : undefined;
      if (pending) pendingSwitch = undefined;
      if (pending && !pending.toggle) {
        switchTrigger = pending.trigger;
        pending.open();
        return;
      }
      await (complete ?? layer.onClose)();
    } finally {
      closing.delete(id);
    }
  };

  const close = (id: string) => {
    if (current.find(layer => layer.id === id)?.busy) {
      setDismissal(id, 'running');
      return Promise.resolve();
    }
    return finishClose(id);
  };

  const confirmDiscard = (id: string) => finishClose(id);

  const canOpen = (kind: LayerKind, id: string) => {
    if (
      kind !== 'dialog' ||
      current.some(layer => layer.id === id) ||
      current.filter(layer => layer.kind === 'dialog').length < 2
    ) {
      return true;
    }
    const error = new Error(
      `Cannot open dialog ${id}: at most two dialogs may be stacked. Use an in-dialog view for nested content.`,
    );
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
    get,
    subscribe,
    top,
    close,
    confirmDiscard,
    dismiss,
    canOpen,
    use: () => useSyncExternalStore(subscribe, get, get),
    stack(id?: string) {
      const depth = current.filter(layer => layer.kind === 'dialog').findIndex(layer => layer.id === id);
      const scrim = 50 + Math.max(0, depth) * 4;
      return { panel: 40, switcher: 45, scrim, dialog: scrim + 1, transient: 65 };
    },
    consumeSwitchTrigger() {
      const target = switchTrigger;
      switchTrigger = undefined;
      return target;
    },
    async complete(id: string, onComplete: () => void | Promise<void>) {
      const layer = current.find(item => item.id === id);
      if (layer?.keepAfterWork) return;
      if (layer) await finishClose(id, onComplete);
      else await onComplete();
    },
    switchPanel(open: () => void, toggle = false) {
      if (top()?.kind === 'dialog') return;
      switchTrigger = undefined;
      const panel = current.find(layer => layer.kind === 'panel');
      if (!panel) {
        open();
        return;
      }
      if (panel.busy || panel.dirty) {
        const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        pendingSwitch = { id: panel.id, open, toggle, trigger };
        dismiss(panel.id);
      } else if (toggle) {
        void close(panel.id);
      } else {
        open();
      }
    },
    open(layer: LayerInput) {
      if (current.some(item => item.id === layer.id)) return;
      if (!canOpen(layer.kind, layer.id)) return;
      if (layer.kind === 'panel') {
        const previous = current.filter(item => item.kind === 'panel');
        pendingSwitch = undefined;
        publish([
          { ...layer, dismissal: 'none', keepAfterWork: false },
          ...current.filter(item => item.kind !== 'panel'),
        ]);
        previous.forEach(item => { void item.onClose(); });
      } else {
        publish([...current, { ...layer, dismissal: 'none', keepAfterWork: false }]);
      }
    },
    remove(id: string) {
      if (!current.some(layer => layer.id === id)) return;
      if (pendingSwitch?.id === id) pendingSwitch = undefined;
      publish(current.filter(layer => layer.id !== id));
    },
    update(id: string, next: Pick<Layer, 'dirty' | 'busy' | 'onClose' | 'onCancel'>) {
      const previous = current.find(layer => layer.id === id);
      if (!previous) return;
      previous.onClose = next.onClose;
      previous.onCancel = next.onCancel;
      if (previous.dirty === next.dirty && previous.busy === next.busy) return;
      const finished = previous.busy && !next.busy && previous.dismissal === 'running';
      const dismissal = previous.dismissal === 'discard' && !next.dirty ? 'none' : previous.dismissal;
      publish(
        current.map(layer =>
          layer.id === id
            ? {
                ...layer,
                ...next,
                dismissal,
                keepAfterWork: !previous.busy && next.busy ? false : layer.keepAfterWork,
              }
            : layer,
        ),
      );
      if (finished) {
        setDismissal(id, 'none');
        void finishClose(id);
      }
    },
    keepOpen(id: string) {
      if (top()?.id !== id) return;
      if (pendingSwitch?.id === id) pendingSwitch = undefined;
      publish(
        current.map(layer =>
          layer.id === id
            ? { ...layer, dismissal: 'none', keepAfterWork: layer.dismissal === 'running' }
            : layer,
        ),
      );
    },
    async stopAndClose(id: string) {
      const layer = top();
      if (layer?.id !== id || !layer.onCancel) return;
      setDismissal(id, 'none');
      if ((await layer.onCancel()) === false) return;
      await finishClose(id);
    },
  };
}

export const layers = createLayerStore();

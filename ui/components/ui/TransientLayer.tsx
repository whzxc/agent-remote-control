import { createContext, useContext, useCallback, useRef, type ReactElement } from 'react';
import { Slot } from 'radix-ui';
import { layers } from '../../state/layers';

export const LayerOwnerContext = createContext<string | undefined>(undefined);

/** Portaled content keeps its React owner's input boundary and stacking level. */
export function TransientLayer({ children, onDismiss, isAnchor }: {
  children: ReactElement; onDismiss: () => void; isAnchor?: (target: Element) => boolean;
}) {
  const owner = useContext(LayerOwnerContext);
  layers.use();
  const handlers = useRef({ onDismiss, isAnchor });
  handlers.current = { onDismiss, isAnchor };
  const register = useCallback((node: HTMLElement | null) => {
    if (node && owner) return layers.ownTransient(node, owner, () => handlers.current.onDismiss(), target => handlers.current.isAnchor?.(target) ?? false);
  }, [owner]);
  return <Slot.Root ref={register} data-layer-owner={owner}
    style={{ zIndex: layers.stack(owner).transient, ...(owner ? { pointerEvents: 'auto' as const } : {}) }}>
    {children}
  </Slot.Root>;
}

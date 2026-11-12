import { createContext, useContext, type ReactElement } from 'react';
import { Slot } from 'radix-ui';
import { layers } from '../../state/layers';

export const LayerOwnerContext = createContext<string | undefined>(undefined);

/** Portaled content keeps its React owner's input boundary and stacking level. */
export function TransientLayer({ children }: { children: ReactElement }) {
  const owner = useContext(LayerOwnerContext);
  layers.use();
  return <Slot.Root data-layer-owner={owner}
    style={{ zIndex: layers.stack(owner).transient, ...(owner ? { pointerEvents: 'auto' as const } : {}) }}>
    {children}
  </Slot.Root>;
}

import type { ReactNode } from 'react';
import type { ProviderAccount } from '../../../types';
import type { WireState } from '../../../topology/render';
import { controlSource } from '../../../controlSources';
import { PlatformIcon } from '../../ui';
import GraphNode from '../../GraphNode';

export function SrcAccountNode({ product, account, sourceLabel, suffix, candidateLabel, state, selected, newlyAdded, onOpen, labelContent }: {
  product: string; account?: Pick<ProviderAccount, 'alias'>; sourceLabel?: string; suffix?: string; candidateLabel?: string;
  state: WireState; selected?: boolean; newlyAdded?: boolean; onOpen: () => void; labelContent?: ReactNode;
}) {
  const alias = account?.alias ?? sourceLabel ?? controlSource(product)?.displayName ?? product;
  const name = `${controlSource(product)?.displayName ?? product} · ${alias}`;
  const label = `${name}${suffix ? ` · ${suffix}` : ''}`;
  return <GraphNode label={label} state={state} highlighted={selected} newlyAdded={newlyAdded} onOpen={onOpen}>
    <PlatformIcon role="source" platform={product} panelVisual /><span className={`graph-node-name${suffix ? ' topology-unidentified-label' : ''}`}>
      {labelContent ?? candidateLabel ?? label}
    </span>
  </GraphNode>;
}

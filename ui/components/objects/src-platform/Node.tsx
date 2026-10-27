import { sourceProductName } from '../../../controlSources';
import type { WireState } from '../../../topology/render';
import { PlatformIcon } from '../../ui';
import GraphNode from '../../GraphNode';

export function SrcPlatformNode({ product, state, selected, newlyAdded, onOpen, count }: {
  product: string; state: WireState; selected?: boolean; newlyAdded?: boolean; onOpen: () => void; count?: number;
}) {
  const name = sourceProductName(product);
  return <GraphNode label={name} state={state} highlighted={selected} newlyAdded={newlyAdded} onOpen={onOpen}>
    <PlatformIcon role="source" platform={product} panelVisual /><span className="graph-node-name">{name}{count !== undefined && <span className="section-header-count">{count}</span>}</span>
  </GraphNode>;
}

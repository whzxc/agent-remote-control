import { NodeCapsule, type NodeTaskState } from './ui/NodeCapsule';
import type { AgentIconReading } from './ui/agent-icon';
import type { ReactNode } from "react";
import { t } from "../i18n";
import type { WireState } from "../topology/render";

export default function GraphNode({ label, state, onOpen, onMove, highlighted, newlyAdded, hideLabel = highlighted, panelExpanded = highlighted, caption, children, capsule, onTasks, capsuleMark, readings, used, compact, wing, onWidth }: {
  capsule?: NodeTaskState; onTasks?: () => void; capsuleMark?: ReactNode; readings?: AgentIconReading[]; used?: boolean; compact?: boolean; wing?: 'left' | 'right'; onWidth?: (width: number) => void;
  label: string; state: WireState; onOpen: () => void; onMove?: (by: number) => void;
  caption?: ReactNode; hideLabel?: boolean; panelExpanded?: boolean; highlighted?: boolean; newlyAdded?: boolean; children: ReactNode;
}) {
  if (capsule && onTasks) return <span className="static-graph-node" data-connection-state={state}>
    <NodeCapsule label={label} state={capsule} graphic={children} mark={capsuleMark} readings={readings} used={used} compact={compact} wing={wing}
      expanded={panelExpanded} onMove={onMove} onOpen={onOpen} onTasks={onTasks} onWidth={onWidth} />
    {caption}
  </span>;
  return <button type="button" className="graph-node" data-panel-anchor data-layer-switcher
    data-highlighted={highlighted || undefined} data-new-source={newlyAdded || undefined} data-connection-state={state}
    aria-label={label} aria-expanded={panelExpanded} aria-haspopup="dialog" aria-description={onMove ? t("reorderNodeHint") : undefined}
    aria-keyshortcuts={onMove ? "ArrowUp ArrowDown" : undefined} onClick={onOpen}
    onKeyDown={event => {
      if (onMove && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1);
      }
    }}>{children}{!hideLabel && caption}</button>;
}

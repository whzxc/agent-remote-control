import { Button } from "./ui";
import type { ReactNode } from "react";
import type { WireState } from "../topology/render";

export default function GraphNode({ label, state, onOpen, highlighted, newlyAdded, children }: {
  label: string; state: WireState; onOpen: () => void;
  highlighted?: boolean; newlyAdded?: boolean; children: ReactNode;
}) {
  return <Button variant="surface" type="button" className="graph-node" data-panel-anchor
    data-highlighted={highlighted || undefined} data-new-source={newlyAdded || undefined} data-connection-state={state}
    aria-label={label} aria-haspopup="dialog" onClick={onOpen}>{children}</Button>;
}

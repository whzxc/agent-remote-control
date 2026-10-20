import { useCallback, useRef, type ReactNode, type MouseEvent } from "react";
import { motion, Reorder, useReducedMotion } from "motion/react";
import { springTransition } from "../motion/geometry";
import { t } from "../i18n";
import type { WireState } from "./ConnectionWires";

export default function GraphNode({ id, label, state, nodes, onOpen, onMove, onMotion, children }: {
  id: string;
  label: string;
  state: WireState;
  nodes: Map<string, HTMLButtonElement>;
  onOpen: () => void;
  onMove?: (by: number) => void;
  onMotion: () => void;
  children: ReactNode;
}) {
  const dragged = useRef(false);
  const reduced = useReducedMotion();
  const attach = useCallback((node: HTMLButtonElement | null) => {
    if (node) nodes.set(id, node);
    else nodes.delete(id);
    onMotion();
  }, [id, nodes, onMotion]);
  const props = {
    ref: attach,
    type: "button" as const,
    className: "graph-node",
    "data-panel-anchor": true,
    "data-connection-state": state,
    "aria-label": label,
    "aria-haspopup": "dialog" as const,
    layout: "position" as const,
    transition: reduced ? { duration: 0 } : springTransition(0.3, 0.9),
    onPointerDownCapture: () => { dragged.current = false; },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (dragged.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onOpen();
    },
    onUpdate: onMotion,
    onLayoutAnimationStart: onMotion,
    onLayoutAnimationComplete: onMotion,
  };
  if (!onMove) return <motion.button {...props}>{children}</motion.button>;
  // Free pointer movement; the enclosing group's y axis owns sorting.
  return <Reorder.Item as="button" value={id} {...props}
    data-reorderable
    aria-description={t("reorderNodeHint")}
    aria-keyshortcuts="ArrowUp ArrowDown"
    drag
    dragMomentum={false}
    dragElastic={!reduced}
    whileDrag={{ cursor: "grabbing" }}
    onDragStart={() => { dragged.current = true; onMotion(); }}
    onDragEnd={onMotion}
    onDragTransitionEnd={onMotion}
    onKeyDown={event => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        onMove(event.key === "ArrowUp" ? -1 : 1);
      }
    }}
  >{children}</Reorder.Item>;
}

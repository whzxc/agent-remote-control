import { DEFAULTS, NODE_R, hubDots, MIN_HUB_RATIO, type Drag, type Entity, type Layout, type NodeGeometry, type Params, type Scene, type Side, type TaskGeometry, type Wing } from './solve.ts';
import { bubbleWidths } from '../state/activityModel.ts';
import { taskHierarchy } from '../state/taskHierarchy.ts';

export interface PortraitGeometry {
  sourceX: number; agentX: number; sourceTop: number; sourceBottom: number; agentTop: number; agentBottom: number;
  earOffset: number; earHalf: number;
  sourceLabelWidth: number; agentLabelWidth: number; sourceAccountLabelWidth: number; agentAccountLabelWidth: number;
}
export interface PortraitLabel { width: number; twoLineWidth: number; height: number }
export interface PortraitLabels { left: ReadonlyMap<string, PortraitLabel>; right: ReadonlyMap<string, PortraitLabel> }

// Portrait owns rows and inward columns. Queue selection and account identity
// remain upstream, so switching orientation never rewrites either ordering.
export function solvePortrait(sc: Scene, p: Params = DEFAULTS, drag: Drag | null = null, labels?: PortraitLabels): Layout {
  const { vw, vh } = sc;
  const column = Math.min(88, Math.max(56, vw * 88 / 900));
  const busGap = Math.min(62, Math.max(30, vw * 62 / 900));
  const finalStub = Math.min(24, Math.max(12, vw * 24 / 900));
  const preferredRe = Math.min(112, vw * 0.16, Math.max(56, vh * 0.08)) * p.ringScale * 0.6;
  const Re = Math.max(preferredRe * MIN_HUB_RATIO, Math.min(preferredRe, (vw - 32) * 130 / 240));
  const hubGap = Math.min(56, Re / 2);
  const earOffset = Re, earHalf = Re * 72 / 112;
  const hasTasks = (e: Entity): boolean => !e.collapsed && (e.tasks.length > 0 || !!e.children?.some(hasTasks));
  const busy = sc.right.some(hasTasks);
  const right = [...sc.right.filter(hasTasks), ...sc.right.filter(e => !hasTasks(e))];
  const children = (e: Entity) => e.collapsed ? [] : e.children ?? [];
  const tasks = (e: Entity) => e.collapsed ? [] : e.tasks;
  const scale = () => p.nodeSize / (NODE_R * 2);
  const label = (e: Entity, side: Side) => labels?.[side === -1 ? 'left' : 'right'].get(e.id);
  const extents = (list: readonly Entity[], side: Side) => ({
    width: Math.max(0, ...list.map(e => (label(e, side)?.width ?? 0) * scale())),
    twoLineWidth: Math.max(0, ...list.map(e => (label(e, side)?.twoLineWidth ?? 0) * scale())),
    offset: list.length ? (NODE_R + 12) * scale() : 0,
  });
  const sourceLabels = extents(sc.left, -1), agentLabels = extents(right, 1);
  const sourceAccounts = extents(sc.left.flatMap(children), -1);
  const agentAccounts = extents(right.flatMap(children), 1);
  const hierarchy = (right.some(e => children(e).length) ? column : 0) + busGap + finalStub;
  // Keep complete single-line labels until the narrow bubble floor no longer fits.
  // Two-line measurements are the lower bound; bubbles absorb any remaining squeeze.
  const agentLabelWidth = Math.max(agentLabels.twoLineWidth, Math.min(agentLabels.width, vw - 32 - hierarchy - bubbleWidths.narrow - agentLabels.offset));
  const agentX = vw - 16 - agentLabels.offset - agentLabelWidth;
  const sourceHierarchy = sc.left.some(e => children(e).length) ? column : 0;
  const sourceAvailable = vw - 32 - sourceLabels.offset - sourceHierarchy;
  const sourceLabelWidth = Math.max(sourceLabels.twoLineWidth, Math.min(sourceLabels.width, sourceAvailable - sourceAccounts.twoLineWidth / 2));
  const sourceX = 16 + sourceLabels.offset + sourceLabelWidth;
  const sourceAccountX = sourceX + column;
  const sourceAccountLabelWidth = Math.min(sourceAccounts.width, 2 * Math.max(1, Math.min(sourceAccountX - 16, vw - 16 - sourceAccountX)));
  const accountX = agentX - column;
  const agentAccountLabelWidth = Math.min(agentAccounts.width, 2 * Math.max(1, Math.min(accountX - 16, vw - 16 - accountX)));
  const taskRight = agentX - hierarchy;
  const stackHeight = (e: Entity) => tasks(e).reduce((h, t) => h + t.height, 0) + Math.max(0, tasks(e).length - 1) * p.taskGap;
  const rowHeight = (e: Entity, side: Side, account = false): number => {
    const nested = children(e), own = stackHeight(e);
    const base = account ? p.nodeSize + 24 : side === -1 ? p.sourceRow : busy && !hasTasks(e) ? p.minIdleRow : p.idleRow;
    const subtree = nested.reduce((h, child) => h + rowHeight(child, side, true), 0) + Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap);
    const measured = label(e, side), s = scale();
    const labelWidth = side === -1 ? account ? sourceAccountLabelWidth : sourceLabelWidth : account ? agentAccountLabelWidth : agentLabelWidth;
    const labelHeight = (measured?.height ?? 0) * s * (measured && measured.width * s > labelWidth ? 2 : 1);
    const labelRow = account ? 2 * (p.nodeSize / 2 + 4 * s + labelHeight) : labelHeight + 16;
    return Math.max(base, labelRow, own + (own ? 20 : 0) + subtree + (own && subtree ? p.rowGap : 0));
  };
  function wing(list: readonly Entity[], side: Side, top: number): Wing {
    const nodes: NodeGeometry[] = [], bubbles: TaskGeometry[] = [];
    const place = (e: Entity, y: number, x: number, parent?: string): number => {
      const height = rowHeight(e, side, !!parent), own = tasks(e), nested = children(e);
      const active = hasTasks(e), idle = side === 1 && busy && !active && !parent;
      const node: NodeGeometry = { id: e.id, parent, tasks: own, active, side, x, y: y + height / 2,
        size: p.nodeSize, scale: 1,
        opacity: idle ? 0.62 : 1, dim: idle, port: 0, arc: null,
        taskBusX: x - busGap, childBusX: x - side * column / 2 };
      if (drag?.kind === 'node' && drag.side === side && drag.id === e.id) {
        node.x = drag.x; node.y = drag.y;
        node.taskBusX = drag.x - busGap; node.childBusX = drag.x - side * column / 2;
      }
      nodes.push(node);
      let taskY = nested.length ? y + 10 : node.y - stackHeight(e) / 2;
      for (const { task, depth, parentTaskId } of taskHierarchy(own)) {
        const available = Math.min(Math.max(bubbleWidths.narrow, Math.min(480, taskRight - 16)), Math.max(1, taskRight - 16));
        const indent = Math.min(depth * 28, Math.max(0, available - 160));
        const width = available - indent;
        const moved = drag?.kind === 'task' && drag.side === side && drag.id === task.id;
        bubbles.push({ ...task, parentTaskId, width, parent: e.id, side, port: 0, anchor: 1,
          x: moved ? Math.max(width + 16, Math.min(taskRight - indent, drag.x)) : taskRight - indent,
          y: moved ? drag.y : taskY + task.height / 2 });
        taskY += task.height + p.taskGap;
      }
      let childY = y + (own.length ? stackHeight(e) + 20 + p.rowGap : (height - nested.reduce((h, c) => h + rowHeight(c, side, true), 0) - Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap)) / 2);
      for (const child of nested) childY += place(child, childY, x - side * column, e.id) + (side === -1 ? 0 : p.rowGap);
      return height;
    };
    let y = top;
    for (const e of list) y += place(e, y, side === -1 ? sourceX : agentX) + p.rowGap;
    return { side, nodes, tasks: bubbles, H: Math.max(0, y - top - p.rowGap), ear: { lo: 0, hi: 0 } };
  }
  const sourceTop = 74, left = wing(sc.left, -1, sourceTop);
  const sourceBottom = sourceTop + left.H;
  const hub = { x: vw / 2, y: sourceBottom + hubGap + earOffset, Re, ...hubDots(sc.hubInteraction) };
  const agentTop = hub.y + earOffset + hubGap, agents = wing(right, 1, agentTop);
  const agentBottom = agentTop + agents.H;
  for (const wing of [left, agents]) {
    if (sc.panel?.side !== wing.side) continue;
    const hidden = new Set<string>();
    for (const node of wing.nodes) {
      if (node.parent && (node.parent === sc.panel.selected || hidden.has(node.parent))) { node.opacity = 0; hidden.add(node.id); }
    }
    for (const task of wing.tasks) { task.hidden = true; task.x += 12; }
  }
  return { vw, vh, sceneH: Math.max(vh, agentBottom + 112), hub, wings: [left, agents],
    portrait: { sourceX, agentX, sourceTop, sourceBottom, agentTop, agentBottom, earOffset, earHalf,
      sourceLabelWidth, agentLabelWidth, sourceAccountLabelWidth, agentAccountLabelWidth },
    balance: [{ core: sourceX, full: vw / 2, squeeze: 1 }, { core: vw - agentX, full: vw / 2, squeeze: 1 }] };
}

export interface PortraitPanelRect { x: number; y: number; width: number; height: number }
export function portraitSourcePanelRoute(node: Pick<NodeGeometry, 'x' | 'y' | 'size' | 'scale'>, panel: PortraitPanelRect) {
  const radius = node.size * node.scale / 2;
  const start = { x: node.x + radius + 4, y: node.y };
  const end = { x: panel.x, y: Math.max(panel.y + 27, Math.min(panel.y + panel.height - 27, node.y)) };
  return [start, { x: panel.x - 12, y: node.y }, { x: panel.x - 12, y: end.y }, end];
}
// Coordinates are scene-local. The host converts them into viewport coordinates;
// vertical scrolling never feeds a panel's animated dimensions back into solve.
export function portraitPanelRect(layout: Layout, selected: NodeGeometry, scrollTop = 0): PortraitPanelRect {
  const p = layout.portrait!;
  if (selected.side === -1) {
    const sources = layout.wings[0].nodes.filter(node => node.opacity > 0);
    const edge = Math.max(...sources.map(node => node.x + Math.max(node.size * node.scale / 2,
      node.parent ? p.sourceAccountLabelWidth / 2 : 0)));
    const x = Math.min(layout.vw - 17, edge + 24);
    return { x, y: 16, width: Math.max(1, layout.vw - 16 - x), height: Math.max(1, layout.vh - 112) };
  }
  const y = Math.max(16, layout.hub.y + p.earOffset + 16 - scrollTop);
  const right = selected.x - selected.size * selected.scale / 2 - 40;
  return { x: 16, y, width: Math.max(1, right - 16), height: Math.max(1, layout.vh - 96 - y) };
}

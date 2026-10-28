import PetLayer, { type PetLayerHandle, type PetGeometry } from "../pets/PetLayer";
import { hubMarkGeometry } from "./geometry";
import { appEnvironment, envOverrides } from "../state/appEnvironment";
import { topologyLayout } from "../subscriptions/displayPreferences";
import { resolveOrientation, type Orientation } from "./orientation";
import { solvePortrait, portraitPanelRect } from "./portrait";
import { PortraitPainter, measurePortraitLabels } from "./portraitRender";
import CollapseSymbol from './CollapseSymbol';
import { t } from '../i18n';
import { topologyCollapsed } from './accountState';
import { highlightedPaths, type PathTask } from './accounts';
import { observeTopology } from "../acceptance";
import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject, type PointerEvent, type MouseEvent } from "react";
import { useMedia } from "../state/hooks";
import { solve, collapseTarget, COLLAPSE_HIT_SIZE, NODE_R, PANEL_MIN_WIDTH, PANEL_MARGIN, panelWidth, type Side, type Scene, type Drag, type Layout, type Task } from "./solve";
import { TopologyAnimator, nodeKey, taskKey } from "./animate";
import { TopologyPainter, type PaintNode, type PaintTask } from "./render";
import { orderedSubset, moveToY } from "./order";
import { topologyValues, topologyDebug } from "../state/topology";
import type { SurfaceRect } from "../motion/surface";

export interface TaskView extends Task, Pick<PathTask, 'members' | 'agentAccountId' | 'origin'>, Omit<PaintTask, "parent" | "side"> { content: ReactNode; reorderable?: boolean; taskId?: string; petTaskIds?: string[]; threadId?: string; count?: number; pending?: boolean; activityQueue?: string }
export interface NodeView extends Omit<PaintNode, "side"> { content: ReactNode; tasks: TaskView[]; reorderable?: boolean; children?: NodeView[]; collapsed?: boolean;
  platformRoot?: boolean; account?: boolean; accountId?: string; sameIdentity?: boolean; platform?: string; platformLabel?: string; label?: string;
  sourceIds?: string[]; icon?: ReactNode; selectedAccountId?: PathTask['agentAccountId'];
  sourceProduct?: string; sourceProductLabel?: string;
}
type PositionedTask = TaskView & { parent: string; side: Side };
export interface TopologyHandle { panelFrame: (rect: SurfaceRect | null) => void }
export interface PanelLayout { key?: string; width: number; expanded: boolean; rect?: SurfaceRect }

export default function Topology({ left: inputLeft, right: inputRight, accountsEnabled = false, brand, boundary, panelKey, panelExpanded = false, onPanelLayout, onReorderNodes, onReorderTasks, ref }: {
  left: NodeView[]; right: NodeView[]; accountsEnabled?: boolean; brand: ReactNode;
  panelExpanded?: boolean;
  panelKey?: string;
  onPanelLayout?: (layout: PanelLayout) => void;
  onReorderNodes: (side: Side, ids: string[]) => void;
  onReorderTasks: (side: Side, parent: string, ids: string[]) => void;
  boundary: RefObject<HTMLElement | null>; ref: Ref<TopologyHandle>;
}) {
  const pets = useRef<PetLayerHandle>(null);
  const graph = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), hub = useRef<HTMLDivElement>(null);
  const portraitSvg = useRef<SVGSVGElement>(null), portraitPainter = useRef<PortraitPainter | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const animator = useRef(new TopologyAnimator()), painter = useRef<TopologyPainter | null>(null);
  const frame = useRef(0), lastTime = useRef(0), panel = useRef<SurfaceRect | null>(null);
  const retarget = useRef(() => {}), placeAfterMorph = useRef(false);
  const orientationSource = useRef<"auto" | "manual">("auto");
  const placedPanel = useRef<string | undefined>(undefined);
  const reportedPanel = useRef<PanelLayout>(undefined);
  const origin = useRef({ x: 0, y: 0 }), size = useRef<{ vw: number; vh: number } | null>(null);
  const drag = useRef<(Drag & { pointer: number; startClientX: number; startClientY: number; grabX: number; grabY: number; parent?: string;
    order: string[]; active: boolean; control: boolean; target: HTMLElement; slot: HTMLElement; key: string }) | null>(null);
  const suppressedClick = useRef<string | null>(null);
  const reduced = useMedia("(prefers-reduced-motion: reduce)"), prefix = useId();
  const params = topologyValues.use(), { guides, slow } = topologyDebug.use();
  const layout = useRef<Layout | null>(null);
  const layoutPreference = topologyLayout.use();
  const orientation = useRef<Orientation>('landscape');
  const orientationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orientationPending = useRef(false);
  const evaluateOrientation = useRef(() => {});
  const collapsed = topologyCollapsed.use();
  const [hover, setHover] = useState<{ side: Side; id: string; task?: boolean } | null>(null);
  const [focus, setFocus] = useState<typeof hover>(null);
  const [hubInteraction, setHubInteraction] = useState<Scene["hubInteraction"]>();
  const [revealed, setRevealed] = useState<string | null>(null);
  const hideToggle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeHover = useCallback((next: typeof hover) => {
    setHover(next);
    // Pointer departure must also clear focus left behind by a pointer click.
    setFocus(null);
    if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    hideToggle.current = null;
    if (next && !next.task) setRevealed(nodeKey(next.side, next.id));
    else hideToggle.current = setTimeout(() => { hideToggle.current = null; setRevealed(null); }, 200);
  }, []);
  const clearInteraction = useCallback(() => {
    setHover(null); setFocus(null); setRevealed(null); setHubInteraction(undefined);
    if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    hideToggle.current = null;
  }, []);
  useEffect(() => {
    window.addEventListener('blur', clearInteraction);
    return () => {
      window.removeEventListener('blur', clearInteraction);
      if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    };
  }, [clearInteraction]);
  const flatten = (list: NodeView[], side: Side, parent?: string): (NodeView & { side: Side })[] => list.flatMap(n => [{ ...n, parent, side }, ...flatten(n.children ?? [], side, n.id)]);
  const fullNodes = [...flatten(inputLeft, -1), ...flatten(inputRight, 1)];
  const prune = (list: NodeView[], side: Side): NodeView[] => list.map(n => {
    const closed = accountsEnabled && collapsed[nodeKey(side, n.id)] === true;
    const children = closed ? [] : prune(n.children ?? [], side);
    const descendantSelected = (items: NodeView[]): boolean => items.some(n => n.selected || descendantSelected(n.children ?? []));
    return { ...n, collapsed: closed, selected: n.selected || closed && descendantSelected(n.children ?? []), children, tasks: closed ? [] : n.tasks };
  });
  const left = prune(inputLeft, -1), right = prune(inputRight, 1);
  const nodes = [...flatten(left, -1), ...flatten(right, 1)];
  const lit = accountsEnabled ? highlightedPaths(fullNodes, focus ?? hover) : null;
  const tasks = nodes.flatMap(n => n.tasks.map(t => ({ ...t, parent: n.id, side: n.side })));
  const [retainedNodes, setRetainedNodes] = useState<typeof nodes>([]);
  const allNodes = [...new Map([...retainedNodes, ...nodes].map(n => [nodeKey(n.side, n.id), n])).values()];
  // Retain departing HTML until its primitive has collapsed into the port.
  const [retained, setRetained] = useState<PositionedTask[]>([]);
  const allTasks = [...new Map([...retained, ...tasks].map(t => [taskKey(t.side, t.id), t])).values()];
  const latest = useRef({ nodes, allNodes, tasks, allTasks, left, right, lit, hover, focus, revealed, hubInteraction, panelKey, panelExpanded, onPanelLayout, reduced, params, guides, slow, onReorderNodes, onReorderTasks });
  latest.current = { nodes, allNodes, tasks, allTasks, left, right, lit, hover, focus, revealed, hubInteraction, panelKey, panelExpanded, onPanelLayout, reduced, params, guides, slow, onReorderNodes, onReorderTasks };
  useEffect(() => observeTopology(() => ({
    orientation: orientation.current, source: orientationSource.current, orientationPending: orientationPending.current,
    origin: origin.current, size: size.current, panel: panel.current,
    interaction: { hover: latest.current.hover, focus: latest.current.focus, revealed: latest.current.revealed },
    nodes: latest.current.nodes.map(({ content: _content, icon: _icon, children: _children, tasks: _tasks, ...node }) => ({ ...node, position: animator.current.values(nodeKey(node.side, node.id)) })),
    tasks: latest.current.allTasks.map(({ content: _content, ...task }) => ({ ...task, position: animator.current.values(taskKey(task.side, task.id)), text: elements.current.get(taskKey(task.side, task.id))?.textContent })),
    primitives: Object.fromEntries([...animator.current.live.keys()].map(key => [key, animator.current.values(key)])),
    paths: [...((orientation.current === "portrait" ? portraitSvg.current : svg.current)?.querySelectorAll("path") ?? [])].map(path => ({ d: path.getAttribute("d"), class: path.getAttribute("class"), opacity: path.getAttribute("opacity"), mask: path.getAttribute("mask") })),
  })), []);
  const petGeometry = (): PetGeometry => ({
    bounds: { x: size.current?.vw ?? 0, y: animator.current.values('scene')?.height ?? 0, top: Math.max(0, 40 - origin.current.y) },
    participant: (p, accountId) => {
      const side = p.kind === 'source' ? -1 : 1;
      const candidates = latest.current.nodes.filter(n => n.side === side && (side === -1 ? n.sourceIds?.includes(p.nativeId) || n.id === p.nativeId : (n.platform ?? n.id) === p.nativeId));
      const node = candidates.find(n => accountId && n.accountId === accountId) ?? candidates.find(n => !n.account) ?? candidates[0];
      const v = node && animator.current.values(nodeKey(side, node.id));
      return v && { x: v.x, y: v.y };
    },
    task: (agent, id) => {
      const grouped = latest.current.tasks.find(task => task.side === 1 && task.petTaskIds?.includes(id) && latest.current.nodes.some(n => n.id === task.parent && (n.platform ?? n.id) === agent));
      const v = animator.current.values(taskKey(1, JSON.stringify([agent, id]))) ?? (grouped && animator.current.values(taskKey(1, grouped.id)));
      return v && { x: v.x - v.anchor * v.width + v.width / 2, y: v.y - v.height / 2 };
    },
  });
  const paint = useCallback(() => {
    pets.current?.layout();
    const a = animator.current, h = a.values("hub"), root = graph.current;
    if (!h || !root) return;
    const portrait = orientation.current === 'portrait';
    root.dataset.orientation = orientation.current;
    const blend = Math.max(0, Math.min(1, a.values('orientation')?.portrait ?? 0));
    for (const [element, opacity, active] of [[svg.current, 1 - blend, !portrait], [portraitSvg.current, blend, portrait]] as const) {
      if (!element) continue;
      element.style.display = opacity < 0.001 ? 'none' : '';
      element.style.opacity = String(opacity);
      element.dataset.inactive = String(!active);
    }
    root.style.height = `${a.values("scene")!.height}px`;
    boundary.current?.style.setProperty("--topology-hub-x", `${h.x}px`);
    if (hub.current) {
      const mark = hubMarkGeometry(h.dotSource, h.dotAgent);
      hub.current.querySelectorAll('[data-hub-arc="top"]').forEach(path => path.setAttribute('d', mark.top));
      hub.current.querySelector('[data-hub-arc="bottom"]')?.setAttribute('d', mark.bottom);
      hub.current.style.setProperty('--source-dot-scale', String(h.dotSource));
      hub.current.style.setProperty('--agent-dot-scale', String(h.dotAgent));
      const size = h.Re * 240 / 130; // Preserve the ARC mark's existing earmuff clearance.
      hub.current.style.width = hub.current.style.height = `${size}px`;
      hub.current.style.setProperty('--hub-rotation', `${h.rotation}deg`);
      const angle = h.rotation * Math.PI / 180;
      hub.current.style.setProperty('--source-dot-x', `${50 - Math.cos(angle) * 32 / 92 * 100}%`);
      hub.current.style.setProperty('--source-dot-y', `${50 - Math.sin(angle) * 32 / 92 * 100}%`);
      hub.current.style.setProperty('--agent-dot-x', `${50 + Math.cos(angle) * 32 / 92 * 100}%`);
      hub.current.style.setProperty('--agent-dot-y', `${50 + Math.sin(angle) * 32 / 92 * 100}%`);
      hub.current.style.setProperty("--hub-dot-size", `${size * 20 / 92}px`);
      hub.current.style.transform = `translate(${h.x - size / 2}px, ${h.y - size / 2}px)`;
    }
    for (const n of latest.current.allNodes) {
      const key = nodeKey(n.side, n.id), v = a.values(key), el = elements.current.get(key);
      if (v && el) {
        el.style.transform = `translate(${v.x - NODE_R}px, ${v.y - NODE_R}px) scale(${v.scale * v.size / (NODE_R * 2)})`;
        el.style.opacity = String(v.op);
        el.style.setProperty('--path-emphasis', String(Math.max(0, Math.min(1, v.emphasis))));
        el.inert = !a.live.get(key)?.alive || v.op < 0.02;
        const scale = v.scale * v.size / (NODE_R * 2);
        el.style.setProperty('--node-inverse', String(1 / scale));
        const columns = layout.current?.portrait;
        if (portrait && columns) {
          const width = n.side === -1 ? n.parent ? columns.sourceAccountLabelWidth : columns.sourceLabelWidth
            : n.parent ? columns.agentAccountLabelWidth : columns.agentLabelWidth;
          el.style.setProperty('--portrait-label-width', `${width / scale}px`);
        }
        const toggle = portrait ? { x: -n.side * v.radius, y: 0 } : collapseTarget(v.radius, v.alo, v.ahi, n.side);
        el.style.setProperty('--collapse-x', `${toggle.x / scale}px`);
        el.style.setProperty('--collapse-y', `${toggle.y / scale}px`);
      } else if (el) {
        el.style.opacity = '0'; el.inert = true;
      }
    }
    for (const t of latest.current.allTasks) {
      const key = taskKey(t.side, t.id), v = a.values(key), el = elements.current.get(key);
      if (!el) continue;
      el.style.opacity = String(v ? v.op : 0);
      const hidden = latest.current.nodes.some(n => n.side === t.side && n.selected);
      el.style.pointerEvents = a.live.get(key)?.alive && !hidden ? "" : "none";
      el.inert = !a.live.get(key)?.alive || hidden;
      if (v) {
        el.style.setProperty('--path-emphasis', String(Math.max(0, Math.min(1, v.emphasis))));
        el.style.width = `${v.width}px`;
        el.style.height = `${v.height}px`;
        el.style.transform = `translate(${v.x - v.anchor * v.width}px, ${v.y - v.height / 2}px)`;
      }
    }
    const rect = panel.current ? { ...panel.current, x: panel.current.x - origin.current.x, y: panel.current.y - origin.current.y } : null;
    svg.current?.style.setProperty("--topology-time-scale", latest.current.slow ? "4" : "1");
    portraitSvg.current?.style.setProperty("--topology-time-scale", latest.current.slow ? "4" : "1");
    if (blend > 0.001) portraitPainter.current?.paint(a, latest.current.allNodes, latest.current.allTasks, rect);
    if (blend < 0.999) painter.current?.paint(a, latest.current.allNodes, latest.current.allTasks, rect,
      latest.current.guides ? layout.current : null);
  }, [boundary]);
  const tick = useCallback((time: number) => {
    frame.current = 0;
    const dt = Math.min(0.064, lastTime.current ? (time - lastTime.current) / 1000 : 1 / 60);
    const moving = animator.current.step(dt * (latest.current.slow ? 0.25 : 1), !!latest.current.reduced);
    lastTime.current = time; paint();
    if (moving) frame.current = requestAnimationFrame(tick);
    else {
      lastTime.current = 0;
      if (placeAfterMorph.current) {
        placeAfterMorph.current = false; placedPanel.current = undefined;
        retarget.current();
      }
      setRetainedNodes(old => {
        const remaining = old.filter(n => animator.current.live.has(nodeKey(n.side, n.id)));
        return remaining.length === old.length ? old : remaining;
      });
      setRetained(old => {
        const remaining = old.filter(t => animator.current.live.has(taskKey(t.side, t.id)));
        return remaining.length === old.length ? old : remaining;
      });
    }
  }, [paint]);
  const wake = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(tick); }, [tick]);
  const scene = useCallback((): Scene => {
    const sc: Scene = { ...size.current!, left: latest.current.left, right: latest.current.right, hubInteraction: latest.current.hubInteraction }, d = drag.current;
    const selected = latest.current.nodes.find(n => n.selected);
    // Reserve only the minimum; following the measured panel would feed its
    // growing width back into the node layout and move the arc again.
    const reservedWidth = Math.min(PANEL_MIN_WIDTH, innerWidth - 2 * PANEL_MARGIN);
    if (selected) sc.panel = { side: selected.side, selected: selected.id,
      edge: selected.side === 1 ? innerWidth - reservedWidth - PANEL_MARGIN - origin.current.x : PANEL_MARGIN + reservedWidth - origin.current.x,
      narrow: innerWidth < 760, overlay: latest.current.panelExpanded };
    if (!d?.active) return sc;
    const wing = d.side === -1 ? "left" : "right";
    if (d.kind === "node") {
      const reorder = (items: NodeView[]): NodeView[] => orderedSubset(items, d.order).map(n => ({ ...n, children: reorder(n.children ?? []) }));
      sc[wing] = reorder(sc[wing] as NodeView[]);
    }
    else {
      const tasks = latest.current.tasks.filter(t => t.side === d.side && t.parent === d.parent);
      const attention = tasks.find(t => t.id === d.id)?.state === "needsYou";
      const allowed = new Set(tasks.filter(t => t.reorderable && (t.state === "needsYou") === attention).map(t => t.id));
      d.order = d.order.filter(id => allowed.has(id));
      const reorder = (items: NodeView[]): NodeView[] => items.map(n => ({ ...n, tasks: n.id === d.parent ? orderedSubset(n.tasks, d.order) : n.tasks, children: reorder(n.children ?? []) }));
      sc[wing] = reorder(sc[wing] as NodeView[]);
    }
    return sc;
  }, []);
  const solveScene = useCallback((activeDrag: Drag | null = null) => {
    const sc = scene();
    if (orientation.current !== 'portrait') return solve(sc, latest.current.params, activeDrag);
    if (graph.current) graph.current.dataset.orientation = 'portrait';
    const labels = measurePortraitLabels(latest.current.nodes, n => elements.current.get(nodeKey(n.side, n.id)));
    return solvePortrait(sc, latest.current.params, activeDrag, labels);
  }, [scene]);
  const target = useCallback(() => {
    if (!size.current) return;
    let d = drag.current;
    if (d && (!(d.kind === "node" ? latest.current.nodes : latest.current.tasks).some(item => item.side === d!.side && item.id === d!.id)
      || latest.current.nodes.some(n => n.selected))) {
      delete d.slot.dataset.dragging; drag.current = null;
      if (d.target.hasPointerCapture(d.pointer)) d.target.releasePointerCapture(d.pointer);
      d = null;
      if (orientationPending.current && orientationTimer.current === null) queueMicrotask(() => evaluateOrientation.current());
    }
    animator.current.params = latest.current.params;
    layout.current = solveScene(d?.active ? d : null);
    // Publish the settled destination once per layout change, never a spring's
    // in-flight position. The dock can then open at its final content width.
    const selected = latest.current.nodes.find(n => n.selected);
    const selectedNode = selected && layout.current.wings.find(w => w.side === selected.side)?.nodes.find(n => n.id === selected.id);
    const radius = selectedNode && (selectedNode.arc?.R ?? selectedNode.size * selectedNode.scale / 2 + latest.current.params.arcGap);
    let rect: SurfaceRect | undefined;
    if (layout.current.portrait && selectedNode && !latest.current.panelExpanded) {
      const container = boundary.current;
      const viewportTop = origin.current.y + (container?.scrollTop ?? 0);
      if (container && placedPanel.current !== latest.current.panelKey) {
        const local = portraitPanelRect(layout.current, selectedNode);
        // Keep the selected node visible while the panel overlays its inward side.
        const neededBottom = Math.max(local.y + Math.min(320, layout.current.vh * 0.5), selectedNode.y + 44);
        const desired = Math.max(0, Math.min(layout.current.sceneH - layout.current.vh, Math.max(container.scrollTop, neededBottom + 96 - layout.current.vh)));
        container.scrollTop = desired;
        const actual = graph.current!.getBoundingClientRect();
        origin.current = { x: actual.x, y: actual.y };
      }
      placedPanel.current = latest.current.panelKey;
      const local = portraitPanelRect(layout.current, selectedNode, container?.scrollTop ?? 0);
      if (selectedNode.side === 1 && envOverrides().taskPanelWidth != null) local.width = Math.min(local.width, envOverrides().taskPanelWidth!);
      rect = { ...local, x: local.x + origin.current.x, y: local.y + viewportTop };
    } else placedPanel.current = undefined;
    const width = rect?.width ?? ((latest.current.panelKey?.startsWith("agent:") ? envOverrides().taskPanelWidth : undefined) ?? (selectedNode && radius !== undefined ? panelWidth(innerWidth, selectedNode.side, origin.current.x + selectedNode.x,
      radius + 2 * Math.max(0.8, layout.current.hub.Re / 130)) : PANEL_MIN_WIDTH));
    const { panelKey: key, panelExpanded: expanded } = latest.current;
    const next: PanelLayout = { key, width, expanded: rect ? false : expanded, rect };
    if (JSON.stringify(reportedPanel.current) !== JSON.stringify(next)) {
      reportedPanel.current = next;
      latest.current.onPanelLayout?.(next);
    }
    animator.current.setTargets(layout.current, d?.active ? d : null);
    animator.current.appearance(latest.current.nodes, latest.current.tasks);
    animator.current.highlight(latest.current.lit);
    // Pins follow the pointer immediately; their neighbours continue springing.
    animator.current.step(0, !!latest.current.reduced);
    paint(); wake();
  }, [paint, wake, solveScene, boundary]);
  retarget.current = target;
  evaluateOrientation.current = () => {
    orientationTimer.current = null;
    if (drag.current) return;
    const env = envOverrides();
    const previous = orientation.current;
    orientation.current = resolveOrientation(orientation.current, topologyLayout.get(), env.windowWidth ?? innerWidth, env.windowHeight ?? innerHeight);
    orientationSource.current = topologyLayout.get() === 'auto' ? 'auto' : 'manual';
    if (previous !== orientation.current) { placedPanel.current = undefined; placeAfterMorph.current = !!latest.current.panelKey; }
    orientationPending.current = false;
    target();
  };
  const scheduleOrientation = useCallback(() => {
    if (orientationTimer.current !== null) clearTimeout(orientationTimer.current);
    orientationPending.current = true;
    orientationTimer.current = setTimeout(() => evaluateOrientation.current(), 150);
  }, []);
  useEffect(() => { scheduleOrientation(); }, [layoutPreference, scheduleOrientation]);
  const startDrag = (event: PointerEvent<HTMLDivElement>, kind: Drag["kind"], side: Side, id: string, parent?: string, control = false) => {
    if (!control && (event.target as Element).closest("[data-topology-control]")) return;
    if (event.button !== 0 || !event.isPrimary || latest.current.nodes.some(n => n.selected)) return;
    const key = kind === "node" ? nodeKey(side, id) : taskKey(side, id), v = animator.current.values(key);
    const button = (event.target as Element).closest("button");
    if (!v || !button || drag.current) return;
    const draggedNode = latest.current.nodes.find(n => n.side === side && n.id === id);
    const candidates = kind === "node" ? latest.current.nodes.filter(n => n.side === side && n.reorderable
      && !!n.account === !!draggedNode?.account && n.parent === draggedNode?.parent
      && (!draggedNode?.account || n.platform === draggedNode.platform))
      : latest.current.tasks.filter(t => t.side === side && t.parent === parent && t.reorderable
        && (t.state === "needsYou") === (latest.current.tasks.find(t => t.side === side && t.id === id)?.state === "needsYou"));
    drag.current = { kind, side, id, parent, x: v.x, y: v.y, pointer: event.pointerId, startClientX: event.clientX, startClientY: event.clientY,
      grabX: event.clientX - origin.current.x - v.x, grabY: event.clientY - origin.current.y - v.y, order: candidates.map(n => n.id), active: false, control,
      target: button, slot: event.currentTarget, key };
    // The check owns capture until its click threshold is exceeded. Retain the
    // original grab point so handing over never jumps or loses the first move.
    if (!control) button.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - d.startClientX, event.clientY - d.startClientY);
    if (!d.active && (d.control ? distance <= 6 : distance < 4)) return;
    d.active = true; d.slot.dataset.dragging = "true"; suppressedClick.current = d.key;
    const y = event.clientY - origin.current.y - d.grabY, movedY = y !== d.y;
    d.x = event.clientX - origin.current.x - d.grabX; d.y = y;
    const layout = solveScene(), wing = layout.wings.find(w => w.side === d.side)!;
    const candidates = (d.kind === "node" ? wing.nodes : wing.tasks.filter(t => t.parent === d.parent)).filter(item => d.order.includes(item.id));
    if (!candidates.some(item => item.id === d.id)) { finishDrag(event, true); return; }
    if (movedY) d.order = moveToY(candidates, d.id, d.y);
    target(); event.preventDefault();
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null; delete d.slot.dataset.dragging;
    if ((!d.control || d.active) && d.target.hasPointerCapture(d.pointer)) d.target.releasePointerCapture(d.pointer);
    if (d.active && !cancelled) {
      if (d.kind === "node") latest.current.onReorderNodes(d.side, d.order);
      else latest.current.onReorderTasks(d.side, d.parent!, d.order);
    }
    if (orientationPending.current && orientationTimer.current === null) evaluateOrientation.current();
    target();
  };
  const suppressClick = (event: MouseEvent, key: string) => {
    if (event.detail !== 0 && suppressedClick.current === key) { event.preventDefault(); event.stopPropagation(); }
  };
  useImperativeHandle(ref, () => ({ panelFrame(rect) {
    // DOMRect dimensions are prototype accessors, not enumerable own properties.
    panel.current = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    paint();
  } }), [paint]);
  useLayoutEffect(() => { setRetained(latest.current.allTasks); setRetainedNodes(latest.current.allNodes); }, [inputLeft, inputRight, collapsed]);
  useLayoutEffect(() => { target(); });
  useLayoutEffect(() => {
    const present = (item: typeof hover) => {
      if (!item) return true;
      const primitive = animator.current.live.get(item.task ? taskKey(item.side, item.id) : nodeKey(item.side, item.id));
      return (item.task ? tasks : nodes).some(n => n.side === item.side && n.id === item.id)
        && (!primitive || primitive.alive && primitive.fields.op.t > 0);
    };
    if (!present(hover) || !present(focus)) clearInteraction();
  });
  const selectedKey = nodes.find(n => n.selected)?.id;
  useLayoutEffect(() => {
    const container = boundary.current, selected = layout.current?.wings.flatMap(w => w.nodes).find(n => n.id === selectedKey);
    if (!container || !selected || orientation.current === "portrait") return;
    const top = selected.y - selected.size * selected.scale / 2 - 8;
    const bottom = selected.y + selected.size * selected.scale / 2 + 24;
    if (top < container.scrollTop) container.scrollTop = Math.max(0, top);
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
  }, [selectedKey, boundary]);
  // Parent host refs attach after child layout effects. Initialize after the
  // whole commit so the painter and viewport observer always mount together.
  useEffect(() => {
    if (!svg.current || !boundary.current || !graph.current) return;
    portraitPainter.current = new PortraitPainter(portraitSvg.current!, prefix, changeHover);
    painter.current = new TopologyPainter(svg.current, prefix, changeHover);
    const container = boundary.current;
    const measure = () => {
      const env = envOverrides();
      const vw = env.windowWidth == null ? container.clientWidth : env.windowWidth - (innerWidth - container.clientWidth);
      const vh = env.windowHeight == null ? container.clientHeight : env.windowHeight - (innerHeight - container.clientHeight);
      if (vw <= 0 || vh <= 0) return;
      size.current = { vw, vh };
      const rect = graph.current!.getBoundingClientRect();
      origin.current = { x: rect.x, y: rect.y }; target(); scheduleOrientation();
    };
    const scroll = () => {
      const rect = graph.current!.getBoundingClientRect();
      const dx = origin.current.x - rect.x, dy = origin.current.y - rect.y;
      origin.current = { x: rect.x, y: rect.y };
      if (drag.current?.active) { drag.current.x += dx; drag.current.y += dy; target(); }
      else if (orientation.current === 'portrait' && latest.current.panelKey) target();
      else paint();
    };
    const observer = new ResizeObserver(measure); observer.observe(container);
    container.addEventListener("scroll", scroll, { passive: true }); window.addEventListener("resize", measure);
    const unsubscribe = appEnvironment.subscribe(measure);
    measure();
    return () => {
      unsubscribe();
      if (orientationTimer.current !== null) clearTimeout(orientationTimer.current);
      drag.current = null; size.current = null;
      cancelAnimationFrame(frame.current); frame.current = 0; lastTime.current = 0;
      observer.disconnect(); container.removeEventListener("scroll", scroll); window.removeEventListener("resize", measure);
      painter.current?.dispose(); painter.current = null;
      portraitPainter.current?.dispose(); portraitPainter.current = null;
    };
  }, [boundary, paint, prefix, target, changeHover, scheduleOrientation]);
  // A new pointer sequence clears the previous drag's click guard, including
  // controls that stop pointerdown before the draggable slot can receive it.
  return <div ref={graph} className="connection-graph topology-scene"
    onPointerLeave={clearInteraction}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) clearInteraction(); }}
    onPointerDownCapture={() => { suppressedClick.current = null; }}
    onPointerMoveCapture={event => { if (drag.current?.control) moveDrag(event); }}
    onPointerUpCapture={event => { if (drag.current?.control) finishDrag(event); }}
    onPointerCancelCapture={event => { if (drag.current?.control) finishDrag(event, true); }}
    onLostPointerCaptureCapture={event => { if (drag.current?.control) finishDrag(event, true); }}
    onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)} onPointerCancel={event => { finishDrag(event, true); clearInteraction(); }}
    onLostPointerCapture={event => finishDrag(event, true)}
    onKeyDownCapture={event => { if (event.key === "Escape" && drag.current) {
      const d = drag.current; drag.current = null; delete d.slot.dataset.dragging;
      if (d.target.hasPointerCapture(d.pointer)) d.target.releasePointerCapture(d.pointer);
      if (orientationPending.current && orientationTimer.current === null) evaluateOrientation.current();
      target(); event.preventDefault(); event.stopPropagation();
    } }}>
    <PetLayer ref={pets} geometry={petGeometry} />
    <svg ref={svg} className="topology-wires" aria-hidden="true" />
    <svg ref={portraitSvg} className="topology-wires portrait-wires" aria-hidden="true" />
    <div ref={hub} className="topology-hub"
      onPointerMove={event => setHubInteraction((event.target as Element).closest('.hub-source') ? 'source' : (event.target as Element).closest('.hub-agent') ? 'agent' : 'hub')}
      onPointerLeave={() => setHubInteraction(undefined)}
      onFocusCapture={event => setHubInteraction((event.target as Element).closest('.hub-source') ? 'source' : (event.target as Element).closest('.hub-agent') ? 'agent' : 'hub')}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHubInteraction(undefined); }}>{brand}</div>
    {allNodes.map(n => <div key={nodeKey(n.side, n.id)} ref={el => { const key = nodeKey(n.side, n.id); if (el) elements.current.set(key, el); else elements.current.delete(key); }}
      data-agent-node={n.side === 1 ? n.platform ?? n.id : undefined} data-source-node={n.side === -1 ? n.platformRoot ? n.id : n.sourceIds?.[0] ?? n.id : undefined}
      data-agent-platform={n.side === 1 && !n.account ? n.platform : undefined}
      data-source-platform={n.side === -1 ? n.platform : undefined}
      data-account-id={n.accountId}
      className={`topology-node ${n.account && n.parent ? "topology-account" : ""} ${n.side === 1 ? "agents" : "sources"}`} data-highlighted={n.selected || undefined} data-reorderable={n.reorderable || undefined}
      data-collapse-visible={revealed === nodeKey(n.side, n.id) || focus?.side === n.side && focus.id === n.id || undefined}
      onPointerEnter={() => changeHover({ side: n.side, id: n.id })} onPointerLeave={() => changeHover(null)} onPointerCancel={() => changeHover(null)}
      onFocusCapture={() => setFocus({ side: n.side, id: n.id })} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) changeHover(null); }}
      onKeyDownCapture={event => {
        if (!accountsEnabled || !n.reorderable || !['ArrowUp', 'ArrowDown'].includes(event.key) || (event.target as HTMLElement).closest('.topology-collapse')) return;
        const peers = nodes.filter(p => p.side === n.side && p.parent === n.parent && p.reorderable && !!p.account === !!n.account && (!n.account || p.account && p.platform === n.platform));
        const index = peers.findIndex(p => p.id === n.id), next = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (next >= 0 && next < peers.length) { const ids = peers.map(p => p.id); [ids[index], ids[next]] = [ids[next], ids[index]]; onReorderNodes(n.side, ids); }
        event.preventDefault(); event.stopPropagation();
      }}
      onPointerDown={n.reorderable ? event => startDrag(event, "node", n.side, n.id) : undefined}
      onClickCapture={event => suppressClick(event, nodeKey(n.side, n.id))}>{n.content}{accountsEnabled && (() => {
        const full = fullNodes.find(p => p.side === n.side && p.id === n.id);
        if (!full || !full.children?.length && !full.tasks.length) return null;
        const closed = collapsed[nodeKey(n.side, n.id)] === true;
        const collect = (node: NodeView): TaskView[] => [...node.tasks, ...(node.children ?? []).flatMap(collect)];
        const ownTasks = collect(full);
        const sourceAccounts = new Set([full.accountId, ...(full.children ?? []).map(c => c.accountId)].filter(Boolean));
        const hiddenTasks = n.side === 1 ? ownTasks : fullNodes.filter(p => p.side === 1).flatMap(p => p.tasks).flatMap(task => task.members?.map(member => ({ ...task, ...member, count: 1 })) ?? [task]).filter(t => sourceAccounts.has(t.origin?.accountId) || !!t.origin?.sourceId && full.sourceIds?.includes(t.origin.sourceId));
        const count = hiddenTasks.reduce((sum, task) => sum + (task.count ?? 1), 0);
        return <>
          <button type="button" className="topology-collapse" aria-label={`${t(closed ? 'topology.expand' : 'topology.collapse')} ${n.label ?? n.id}`} aria-expanded={!closed}
            style={{ width: COLLAPSE_HIT_SIZE, height: COLLAPSE_HIT_SIZE }}
            onPointerEnter={() => changeHover({ side: n.side, id: n.id })}
            onPointerLeave={event => changeHover(event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget) ? { side: n.side, id: n.id } : null)}
            onPointerCancel={() => changeHover(null)}
            onPointerDown={event => event.stopPropagation()} onClick={() => { topologyCollapsed.set(old => ({ ...old, [nodeKey(n.side, n.id)]: !closed })); }}>
            <CollapseSymbol collapsed={closed} />
          </button>
          {(closed || panelKey?.startsWith('agent:') && n.side === 1 && !n.selected && !n.children?.length) && count > 0 && <span className="agent-task-count" data-attention={hiddenTasks.some(t => t.state === 'needsYou' || t.pending) || undefined} aria-label={t('topology.hiddenTasks', { count })}>{count}</span>}
        </>;
      })()}</div>)}
    {allTasks.map(t => <div key={taskKey(t.side, t.id)} ref={el => { const key = taskKey(t.side, t.id); if (el) elements.current.set(key, el); else elements.current.delete(key); }}
      className="activity-slot" data-highlighted={t.selected || undefined} data-reorderable={t.reorderable || undefined} data-activity-queue={t.activityQueue}
      onPointerEnter={() => changeHover({ side: t.side, id: t.id, task: true })} onPointerLeave={() => changeHover(null)} onPointerCancel={() => changeHover(null)}
      onFocusCapture={() => setFocus({ side: t.side, id: t.id, task: true })} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) changeHover(null); }}
      onPointerDownCapture={t.reorderable ? event => {
        if ((event.target as Element).closest("[data-topology-control]")) startDrag(event, "task", t.side, t.id, t.parent, true);
      } : undefined}
      onPointerDown={t.reorderable ? event => startDrag(event, "task", t.side, t.id, t.parent) : undefined}
      onClickCapture={event => suppressClick(event, taskKey(t.side, t.id))}>{t.content}</div>)}
  </div>;
}

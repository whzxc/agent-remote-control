import { readLayerTokens } from "../components/ui/layerTokens";
import DeviceSummary from '../devices/DeviceSummary';
import { participantPost, petSize, bubbleEnd, wanderPost, petPath, overlaps, type Rect } from '../pets/geometry';
import PetLayer, { type PetLayerHandle, type PetGeometry } from "../pets/PetLayer";
import { arcActionRegion, hubMarkGeometry, hubControlGeometry } from "./geometry";
import ArcActions, { type ArcActionsHandle } from './ArcActions';
import type { ActivityReadTarget } from '../state/activityBubbles';
import { appEnvironment, envOverrides } from "../state/appEnvironment";
import { topologyLayout } from "../subscriptions/displayPreferences";
import { resolveOrientation, type Orientation } from "./orientation";
import { solvePortrait } from "./portrait";
import { PortraitPainter } from "./portraitRender";
import { compactRoots, compactLayout, compactTree, topologyGroups, topologyPinned, retainOpenGroup, type TopologyGroupPlan, type CompactPlan } from './compact';
import { t } from '../i18n';
import { TopologyGroup } from '../components/ui/TopologyGroup';
import { BrandMark } from '../components/ui';
import SourceIcon from '../components/SourceIcon';
import { icons } from '../state/agents';
import type { ProviderSnapshot } from '../subscriptions/types';
import { layers as layerStore } from '../state/layers';
import { topologyCollapsed } from './accountState';
import { highlightedPaths, type PathTask } from './accounts';
import { observeTopology } from "../acceptance";
import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject, type PointerEvent, type MouseEvent } from "react";
import { useMedia } from "../state/hooks";
import { NODE_R, type Side, type Scene, type Drag, type Layout, type Task } from "./solve";
import { TopologyAnimator, nodeKey, taskKey } from "./animate";
import { TopologyPainter, type PaintNode, type PaintTask } from "./render";
import { orderedSubset, moveToY } from "./order";
import { topologyValues, topologyDebug } from "../state/topology";
import type { LayerRect as SurfaceRect } from "../components/ui/layerFrame";

export interface TaskView extends Task, Pick<PathTask, 'members' | 'agentAccountId' | 'origin'>, Omit<PaintTask, "parent" | "side"> { content: ReactNode; reorderable?: boolean; taskId?: string; petTaskIds?: string[]; threadId?: string; count?: number; pending?: boolean; activityQueue?: string; activityAt?: number }
export interface NodeView extends Omit<PaintNode, "side"> { content: ReactNode; tasks: TaskView[]; reorderable?: boolean; children?: NodeView[]; collapsed?: boolean;
  unread?: ActivityReadTarget[];
  platformRoot?: boolean; account?: boolean; accountId?: string; sameIdentity?: boolean; platform?: string; platformLabel?: string; label?: string;
  sourceIds?: string[]; icon?: ReactNode; selectedAccountId?: PathTask['agentAccountId'];
  groupMember?: string; group?: TopologyGroupPlan; quota?: ProviderSnapshot;
  activityAt?: number; activityLevel?: number; pinned?: boolean;
  sourceProduct?: string; sourceProductLabel?: string;
}
type PositionedTask = TaskView & { parent: string; side: Side };
export interface TopologyHandle { memberLayerPointer: (event: Event) => void; panelFrame: (rect: SurfaceRect | null) => void }

export default function Topology({ left: inputLeft, right: inputRight, accountsEnabled = false, brand, boundary, panelKey, panelExpanded = false, onCollapseSide, onMarkRead, onReorderNodes, onReorderTasks, ref }: {
  left: NodeView[]; right: NodeView[]; accountsEnabled?: boolean; brand: ReactNode;
  panelExpanded?: boolean;
  panelKey?: string;
  onCollapseSide?: (side: Side) => void;
  onMarkRead?: (targets: readonly ActivityReadTarget[]) => void;
  onReorderNodes: (side: Side, ids: string[]) => void;
  onReorderTasks: (side: Side, parent: string, ids: string[]) => void;
  boundary: RefObject<HTMLElement | null>; ref: Ref<TopologyHandle>;
}) {
  const pets = useRef<PetLayerHandle>(null);
  const graph = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), hub = useRef<HTMLDivElement>(null), deviceSummary = useRef<HTMLDivElement>(null);
  const portraitSvg = useRef<SVGSVGElement>(null), portraitPainter = useRef<PortraitPainter | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const arcControls = useRef(new Map<string, ArcActionsHandle>());
  const actionRegions = useRef(new Map<string, Rect>());
  const actionPointer = useRef<{ x: number; y: number } | null>(null);
  const pointerActionOwner = useRef<string | null>(null);
  const animator = useRef(new TopologyAnimator()), painter = useRef<TopologyPainter | null>(null);
  const frame = useRef(0), lastTime = useRef(0), panel = useRef<SurfaceRect | null>(null);
  const retarget = useRef(() => {});
  const orientationSource = useRef<"auto" | "manual">("auto");
  const origin = useRef({ x: 0, y: 0 }), size = useRef<{ vw: number; vh: number } | null>(null);
  const drag = useRef<(Drag & { pointer: number; startClientX: number; startClientY: number; grabX: number; grabY: number; parent?: string;
    order: string[]; initialOrder: string[]; active: boolean; control: boolean; target: HTMLElement; slot: HTMLElement; key: string }) | null>(null);
  const suppressedClick = useRef<string | null>(null);
  const reduced = useMedia("(prefers-reduced-motion: reduce)"), prefix = useId();
  const params = topologyValues.use(), { guides, slow } = topologyDebug.use();
  const layout = useRef<Layout | null>(null);
  const layoutPreference = topologyLayout.use();
  const orientation = useRef<Orientation>('landscape');
  const [viewport, setViewport] = useState({ vw: 0, vh: 0, orientation: 'landscape' as Orientation });
  const orientationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orientationPending = useRef(false);
  const evaluateOrientation = useRef(() => {});
  const collapsed = topologyCollapsed.use();
  const closedWing = collapsed['wing:-1'] ? -1 : collapsed['wing:1'] ? 1 : undefined;
  const previousClosedWing = useRef(closedWing);
  useLayoutEffect(() => {
    const folded = closedWing !== undefined && previousClosedWing.current !== closedWing;
    previousClosedWing.current = closedWing;
    if (folded && orientation.current === 'portrait' && boundary.current) {
      boundary.current.scrollTop = 0;
      const rect = graph.current?.getBoundingClientRect();
      if (rect) origin.current = { x: rect.x, y: rect.y };
    }
  }, [closedWing, boundary]);
  const [openedGroup, setOpenedGroup] = useState<TopologyGroupPlan | null>(null);
  const expandedGroups = useMemo(() => new Set(openedGroup ? [openedGroup.id] : []), [openedGroup]);
  const insidePointers = useRef(new WeakSet<Event>());
  const focusGroup = useRef<{ id: string; member: boolean } | null>(null);
  const pendingGroupFocus = useRef<string | null>(null);
  const openGroup = (group: TopologyGroupPlan) => {
    focusGroup.current = { id: group.id, member: true };
    setOpenedGroup({ ...group, members: [...group.members] });
  };
  const foldGroup = (id: string) => {
    focusGroup.current = { id, member: false };
    setHover(null); setFocus(null);
    setOpenedGroup(null);
  };
  const markGroupPointer = useCallback((event: Event, target: { side: Side; id: string; task?: boolean }) => {
    const current = latest.current;
    const owner = target.task ? current.tasks.find(t => t.side === target.side && t.id === target.id)?.parent : target.id;
    const node = current.allNodes.find(n => n.side === target.side && n.id === owner);
    if (node && (current.expandedGroups.has(node.groupMember ?? '') || current.expandedGroups.has(node.id))) insidePointers.current.add(event);
  }, []);
  const [hover, setHover] = useState<{ side: Side; id: string; task?: boolean } | null>(null);
  const [focus, setFocus] = useState<typeof hover>(null);
  const [hubInteraction, setHubInteraction] = useState<Scene["hubInteraction"]>();
  const [revealed, setRevealed] = useState<string | null>(null);
  const hideToggle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealActions = useCallback((key: string | null) => {
    if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    hideToggle.current = null;
    const owner = pointerActionOwner.current ?? key;
    if (owner) setRevealed(owner);
    else hideToggle.current = setTimeout(() => { hideToggle.current = null; setRevealed(null); }, 200);
  }, []);
  const changeHover = useCallback((next: typeof hover) => {
    setHover(next);
    // Pointer departure must also clear focus left behind by a pointer click.
    setFocus(null);
  }, []);
  const updateActionPointer = useCallback(() => {
    const pointer = actionPointer.current;
    if (!pointer) return;
    const x = pointer.x - origin.current.x, y = pointer.y - origin.current.y;
    const owner = [...actionRegions.current].filter(([, r]) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)
      .sort(([, a], [, b]) => a.width * a.height - b.width * b.height)[0]?.[0] ?? null;
    if (pointerActionOwner.current === owner) return;
    pointerActionOwner.current = owner;
    revealActions(owner);
  }, [revealActions]);
  // Transition blur clears highlights while its requested focus restoration waits.
  const clearInteraction = useCallback(() => {
    actionPointer.current = null; pointerActionOwner.current = null;
    setHover(null); setFocus(null); setRevealed(null); setHubInteraction(undefined);
    if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    hideToggle.current = null;
  }, []);
  useEffect(() => {
    const blur = () => { pendingGroupFocus.current = null; clearInteraction(); };
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('blur', blur);
      if (hideToggle.current !== null) clearTimeout(hideToggle.current);
    };
  }, [clearInteraction]);
  const flatten = (list: NodeView[], side: Side, parent?: string): (NodeView & { side: Side })[] => list.flatMap(n => [{ ...n, parent, side }, ...flatten(n.children ?? [], side, n.id)]);
  const fullNodes = [...flatten(inputLeft, -1), ...flatten(inputRight, 1)];
  const unreadUnder = (node: NodeView): ActivityReadTarget[] => [...node.unread ?? [], ...(node.children ?? []).flatMap(unreadUnder)];
  const restoreNodeFocus = (key: string) => elements.current.get(key)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  const selectedSide = fullNodes.find(node => node.selected)?.side;
  useLayoutEffect(() => {
    if (closedWing === undefined) return;
    const visible = closedWing === -1 ? inputRight : inputLeft;
    if (selectedSide === closedWing || !visible.length) topologyCollapsed.set(old => ({ ...old, [`wing:${closedWing}`]: false }));
  }, [closedWing, selectedSide, inputLeft.length, inputRight.length]);
  const prune = (list: NodeView[], side: Side): NodeView[] => list.map(n => {
    const closed = accountsEnabled && collapsed[nodeKey(side, n.id)] === true;
    const children = closed ? [] : prune(n.children ?? [], side);
    const descendantSelected = (items: NodeView[]): boolean => items.some(n => n.selected || descendantSelected(n.children ?? []));
    return { ...n, pinned: topologyPinned(n), collapsed: closed, selected: n.selected || closed && descendantSelected(n.children ?? []), children, tasks: closed ? [] : n.tasks };
  });
  const prunedLeft = closedWing === -1 ? [] : prune(inputLeft, -1), prunedRight = closedWing === 1 ? [] : prune(inputRight, 1);
  const [portraitPlan, setPortraitPlan] = useState<CompactPlan>(() => ({ left: new Set(), right: new Set() }));
  const portraitPlanRef = useRef(portraitPlan); portraitPlanRef.current = portraitPlan;
  const landscapePlan = useMemo(() => viewport.vw > 0 && viewport.orientation === 'landscape' ? compactRoots(prunedLeft, prunedRight, viewport, 'landscape', params) : { left: new Set<string>(), right: new Set<string>() }, [inputLeft, inputRight, collapsed, accountsEnabled, viewport, params]);
  const basePlan = viewport.orientation === 'portrait' ? portraitPlan : landscapePlan;
  const compacted = useMemo(() => retainOpenGroup(basePlan, prunedLeft, prunedRight, openedGroup), [basePlan, prunedLeft, prunedRight, openedGroup]);
  const groups = [...topologyGroups(prunedLeft, compacted.left, -1), ...topologyGroups(prunedRight, compacted.right, 1)];
  const mark = (list: NodeView[], side: Side, inherited?: string): NodeView[] => list.map(n => {
    const member = inherited ?? groups.find(g => g.side === side && g.members.includes(n.id))?.id;
    return { ...n, groupMember: member, children: mark(n.children ?? [], side, member) };
  });
  const left = mark(prunedLeft, -1), right = mark(prunedRight, 1);
  const groupNode = (group: TopologyGroupPlan, members: NodeView[]): NodeView => {
    const portrait = viewport.orientation === 'portrait';
    const label = t(portrait ? 'topology.idle' : group.parent ? 'topology.idleAccounts' : group.side === 1 ? 'topology.idleAgents' : 'topology.idleSources', { count: members.length });
    return { id: group.id, group, label, state: 'normal', attention: false, selected: false, tasks: [], content: <TopologyGroup label={label}
      members={members.map(n => ({ brand: n.platform ?? n.id, quota: n.quota,
        mark: group.side === 1 ? <BrandMark markup={icons[n.platform ?? n.id]} size={28} /> : <SourceIcon platform={n.platform ?? n.id} panelVisual /> }))}
      layout={portrait ? group.side === -1 ? 'source' : 'agent' : 'vertical'}
      aria-expanded={expandedGroups.has(group.id)}
      onClick={() => openGroup(group)} /> };
  };
  const groupedLeft = compactTree(left, compacted.left, -1, expandedGroups, groupNode);
  const groupedRight = compactTree(right, compacted.right, 1, expandedGroups, groupNode);
  const nodes = [...flatten(groupedLeft, -1), ...flatten(groupedRight, 1)];
  // Expanded capsules stay mounted as focus-return targets, outside the solver.
  const dormantGroups = groups.filter(g => expandedGroups.has(g.id)).map(g => ({ ...groupNode(g, (g.side === -1 ? fullNodes.filter(n => n.side === -1) : fullNodes.filter(n => n.side === 1)).filter(n => g.members.includes(n.id))), side: g.side, parent: g.parent }));
  useLayoutEffect(() => {
    const request = focusGroup.current;
    if (!request) return;
    focusGroup.current = null;
    const group = groups.find(g => g.id === request.id);
    const target = request.member ? nodes.find(n => n.groupMember === request.id) : group;
    if (target) pendingGroupFocus.current = nodeKey(target.side, target.id);
  }, [expandedGroups, compacted]);
  const lit = accountsEnabled ? highlightedPaths(fullNodes, focus ?? hover) : null;
  const tasks = nodes.flatMap(n => n.tasks.map(t => ({ ...t, parent: n.id, side: n.side })));
  const [retainedNodes, setRetainedNodes] = useState<typeof nodes>([]);
  const allNodes = [...new Map([...retainedNodes, ...flatten(left, -1), ...flatten(right, 1), ...dormantGroups, ...nodes].map(n => [nodeKey(n.side, n.id), n])).values()];
  // Retain departing HTML until its primitive has collapsed into the port.
  const [retained, setRetained] = useState<PositionedTask[]>([]);
  const allTasks = [...new Map([...retained, ...tasks].map(t => [taskKey(t.side, t.id), t])).values()];
  const latest = useRef({ nodes, fullNodes, allNodes, tasks, allTasks, left, right, groups, compacted, expandedGroups, lit, hover, focus, revealed, hubInteraction, panelKey, panelExpanded, reduced, params, guides, slow, onReorderNodes, onReorderTasks });
  latest.current = { nodes, fullNodes, allNodes, tasks, allTasks, left, right, groups, compacted, expandedGroups, lit, hover, focus, revealed, hubInteraction, panelKey, panelExpanded, reduced, params, guides, slow, onReorderNodes, onReorderTasks };
  useEffect(() => {
    if (!openedGroup) return;
    // Decide after React capture and SVG target handlers have classified the
    // event. A capture-listener microtask can run before those handlers.
    const outside = (event: globalThis.PointerEvent) => {
      if (!insidePointers.current.has(event) && latest.current.expandedGroups.has(openedGroup.id)) {
        pendingGroupFocus.current = null;
        setOpenedGroup(current => current?.id === openedGroup.id ? null : current);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || latest.current.panelKey || layerStore.get().length) return;
      event.preventDefault(); foldGroup(openedGroup.id);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [openedGroup]);
  useEffect(() => observeTopology(() => ({
    orientation: orientation.current, source: orientationSource.current, orientationPending: orientationPending.current,
    origin: origin.current, size: size.current, panel: panel.current,
    interaction: { hover: latest.current.hover, focus: latest.current.focus, revealed: latest.current.revealed },
    groups: latest.current.groups.map(group => ({ ...group, folded: !latest.current.expandedGroups.has(group.id), position: animator.current.values(nodeKey(group.side, group.id)) })),
    nodes: latest.current.nodes.map(({ content: _content, icon: _icon, children: _children, tasks: _tasks, ...node }) => ({ ...node, position: animator.current.values(nodeKey(node.side, node.id)) })),
    tasks: latest.current.allTasks.map(({ content: _content, ...task }) => ({ ...task, position: animator.current.values(taskKey(task.side, task.id)), text: elements.current.get(taskKey(task.side, task.id))?.textContent })),
    primitives: Object.fromEntries([...animator.current.live.keys()].map(key => [key, animator.current.values(key)])),
    paths: [...((orientation.current === "portrait" ? portraitSvg.current : svg.current)?.querySelectorAll("path") ?? [])].map(path => ({ d: path.getAttribute("d"), class: path.getAttribute("class"), opacity: path.getAttribute("opacity"), mask: path.getAttribute("mask") })),
  })), []);
  const petGeometry = (): PetGeometry => {
    const bounds = { x: size.current?.vw ?? 0, y: animator.current.values('scene')?.height ?? 0, top: Math.max(0, 40 - origin.current.y) };
    const hub = animator.current.values('hub');
    const nodeRects = new Map<string, Rect>(), nodeLabels = new Map<string, Rect[]>();
    const chrome = [...document.querySelectorAll<HTMLElement>('.board-header, .navigation-capsule:not([hidden])')].flatMap(element => {
      const r = element.getBoundingClientRect();
      return r.width && r.height ? [{ x: r.x - origin.current.x - 8, y: r.y - origin.current.y - 8, width: r.width + 16, height: r.height + 16 }] : [];
    });
    const obstacles: Rect[] = [...chrome];
    for (const n of latest.current.nodes) {
      const key = nodeKey(n.side, n.id), v = animator.current.values(key);
      if (!v || v.op < .02) continue;
      const radius = v.size * v.scale / 2;
      const icon = { x: v.x - radius, y: v.y - radius, width: radius * 2, height: radius * 2 };
      const parts = [icon];
      for (const label of elements.current.get(key)?.querySelectorAll<HTMLElement>('.graph-node-name, .agent-auto-compact') ?? []) {
        if (n.group) continue;
        const r = label.getBoundingClientRect();
        if (r.width && r.height) parts.push({ x: r.x - origin.current.x, y: r.y - origin.current.y, width: r.width, height: r.height });
      }
      obstacles.push(...parts); nodeLabels.set(key, parts.slice(1));
      const x = Math.min(...parts.map(r => r.x)), y = Math.min(...parts.map(r => r.y));
      nodeRects.set(key, { x, y, width: Math.max(...parts.map(r => r.x + r.width)) - x, height: Math.max(...parts.map(r => r.y + r.height)) - y });
    }
    const bubbleFrames = latest.current.tasks.flatMap(task => {
      const v = animator.current.values(taskKey(task.side, task.id));
      return v && v.op > .02 ? [{ task, rect: { x: v.x - v.anchor * v.width, y: v.y - v.height / 2, width: v.width, height: v.height } }] : [];
    });
    const taskFrame = (agent: string, id: string) => {
      const own = bubbleFrames.filter(({ task }) => task.side === 1 && latest.current.nodes.some(n => n.id === task.parent && (n.platform ?? n.id) === agent));
      return (own.find(({ task }) => task.taskId === id) ?? own.find(({ task }) => task.petTaskIds?.includes(id)))?.rect;
    };
    return {
      bounds, taskFrame,
      taskPresent: (agent, id) => latest.current.tasks.some(task => task.side === 1 &&
        (task.taskId === id || task.petTaskIds?.includes(id)) && latest.current.nodes.some(n => n.id === task.parent && (n.platform ?? n.id) === agent)),
      interaction: (p, kind, pet, anchors) => {
        if (!hub || latest.current.panelKey || drag.current || orientationPending.current) return undefined;
        const side = p.kind === 'source' ? -1 : 1;
        const candidates = latest.current.nodes.filter(n => !n.group && n.side === side && nodeRects.has(nodeKey(n.side, n.id)) &&
          (side === -1 ? n.sourceIds?.includes(p.nativeId) || n.id === p.nativeId : (n.platform ?? n.id) === p.nativeId));
        const node = (side === -1 ? candidates.find(n => n.id === p.nativeId) : candidates.find(n => !n.account)) ?? candidates[0];
        if (!node) return undefined;
        const key = nodeKey(side, node.id), position = animator.current.values(key);
        let pivot: { x: number; y: number } | undefined;
        if (kind === 'sit') {
          const radius = hub.Re * 240 / 130 * 32 / 92;
          const mark = hubMarkGeometry(hub.dotSource, hub.dotAgent), rotation = hub.rotation * Math.PI / 180;
          const desired = -Math.PI / 2 + side * .48;
          const normalize = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
          const local = normalize(desired - rotation);
          const arcs = [[-Math.PI + mark.sourceAngle + .12, -mark.agentAngle - .12], [mark.agentAngle + .12, Math.PI - mark.sourceAngle - .12]];
          const angles = arcs.filter(([lo, hi]) => lo <= hi).map(([lo, hi]) => Math.max(lo, Math.min(hi, local)));
          if (!angles.length) return undefined;
          const angle = angles.sort((a, b) => Math.abs(normalize(a - local)) - Math.abs(normalize(b - local)))[0] + rotation;
          pivot = { x: hub.x + Math.cos(angle) * radius, y: hub.y + Math.sin(angle) * radius };
        } else if (kind === 'swing') {
          const point = orientation.current === 'portrait' ? portraitPainter.current?.contact(side, .2) : painter.current?.contact(key, .55);
          if (point) pivot = { x: point.x, y: point.y };
        } else if (position) pivot = { x: position.x - side * (position.size * position.scale / 2 + 8), y: position.y };
        if (!pivot) return undefined;
        const pivots = kind === 'pull' && position ? [pivot, { x: 2 * position.x - pivot.x, y: pivot.y }] : [pivot];
        for (const contact of pivots) {
          const facing = (kind === 'pull' && position ? contact.x > position.x ? -1 : 1 : -side) as -1 | 1;
          const rig = anchors?.(facing);
          const anchor = rig ? kind === 'sit' ? rig.seat : rig.grip : { x: kind === 'pull' && position ? contact.x > position.x ? .25 : .75 : .5, y: kind === 'sit' ? .73 : kind === 'swing' ? .28 : .5 };
          const point = { x: contact.x - pet.width * anchor.x, y: contact.y - pet.height * anchor.y };
          const footprint = { ...point, width: pet.width, height: pet.height + pet.tagHeight };
          if (point.x < 0 || point.y < bounds.top || point.x + pet.width > bounds.x || point.y + footprint.height > bounds.y ||
            chrome.some(rect => overlaps(footprint, rect)) || bubbleFrames.some(b => overlaps(footprint, b.rect)) || kind === 'pull' && nodeLabels.get(key)?.some(label => overlaps(footprint, label)) || [...nodeRects].some(([id, r]) => !(kind === 'pull' && id === key) && overlaps(footprint, r))) continue;
          return { point, pivot: contact, facing, ...(kind === 'pull' ? { targetId: key } : {}) };
        }
      },
      feedback: (key, amount) => {
        const element = elements.current.get(key)?.querySelector<HTMLElement>('.graph-node');
        if (!element) return;
        const value = latest.current.reduced || drag.current ? 0 : Math.max(-1, Math.min(1, amount));
        element.style.translate = value ? `${value * 9}px 0` : '';
        element.style.rotate = value ? `${value * 5}deg` : '';
      },
      route: (from, to, size, occupied = []) => petPath(from, to, bounds, [...obstacles, ...occupied, ...bubbleFrames.map(b => b.rect),
        ...(hub ? [{ x: hub.x - hub.Re, y: hub.y - hub.Re, width: hub.Re * 2, height: hub.Re * 2 }] : [])], size),
      wander: (from, pet, occupied) => {
        const bubbles = latest.current.tasks.flatMap(task => {
          const v = animator.current.values(taskKey(task.side, task.id));
          return v && v.op > .02 ? [{ x: v.x - v.anchor * v.width, y: v.y - v.height / 2, width: v.width, height: v.height }] : [];
        });
        const bottom = (boundary.current?.getBoundingClientRect().bottom ?? innerHeight) - origin.current.y - 16;
        const hubRect = hub ? [{ x: hub.x - hub.Re, y: hub.y - hub.Re, width: hub.Re * 2, height: hub.Re * 2 }] : [];
        return wanderPost(from, { ...bounds, y: Math.min(bounds.y, bottom) }, [...obstacles, ...bubbles, ...hubRect, ...occupied], pet);
      },
      participant: (p, accountId, size = petSize('participant', p.brand === 'other')) => {
        const side = p.kind === 'source' ? -1 : 1;
        const candidates = latest.current.nodes.filter(n => n.side === side && nodeRects.has(nodeKey(n.side, n.id)) && (side === -1 ? n.sourceIds?.includes(p.nativeId) || n.id === p.nativeId : (n.platform ?? n.id) === p.nativeId));
        const node = candidates.find(n => side === -1 && n.id === p.nativeId || accountId && n.accountId === accountId) ?? candidates.find(n => !n.account) ?? candidates[0];
        const rect = node && nodeRects.get(nodeKey(side, node.id));
        return rect && hub ? participantPost(rect, { x: hub.x, y: hub.y }, obstacles, bounds, size) : undefined;
      },
      task: (agent, id) => {
        // Use the actual rendered task identity, including account/aggregate projection.
        const own = latest.current.tasks.filter(task => task.side === 1 && latest.current.nodes.some(n => n.id === task.parent && (n.platform ?? n.id) === agent));
        const task = own.find(task => task.taskId === id) ?? own.find(task => task.petTaskIds?.includes(id));
        const v = task && animator.current.values(taskKey(task.side, task.id));
        return v && v.op > .02 ? bubbleEnd({ x: v.x, y: v.y, width: v.width, height: v.height, anchor: v.anchor }) : undefined;
      },
    };
  };
  const paint = useCallback(() => {
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
    const app = boundary.current?.closest<HTMLElement>('.app-scene');
    if (app) app.style.setProperty('--topology-hub-x', `${h.x + origin.current.x - app.getBoundingClientRect().left}px`);
    const portraitFrame = a.values('portrait');
    actionRegions.current.clear();
    for (const side of [-1, 1] as const) {
      const control = arcControls.current.get(`wing:${side}`);
      if (!control) continue;
      const ear = a.values(`ear${side}`)!;
      control.place(portrait && portraitFrame ? { kind: 'line',
        start: { x: h.x + side * portraitFrame.earOffset, y: h.y },
        end: { x: h.x + side * (portraitFrame.earOffset + portraitFrame.earHalf), y: h.y }, outward: { x: 0, y: side } }
        : { kind: 'arc', x: h.x, y: h.y, radius: h.Re, lo: ear.lo, hi: ear.hi, side }, true);
      const reach = portrait && portraitFrame ? portraitFrame.earOffset + portraitFrame.earHalf + 34 : h.Re + 34;
      actionRegions.current.set(`wing:${side}`, { x: side === -1 ? h.x - reach : h.x, y: h.y - h.Re - 12, width: reach, height: 2 * (h.Re + 12) });
    }
    if (deviceSummary.current) deviceSummary.current.style.transform = `translate(${h.x - 120}px, ${h.y + hubControlGeometry(h.Re).size / 2 + 20}px)`;
    if (hub.current) {
      const mark = hubMarkGeometry(h.dotSource, h.dotAgent);
      hub.current.querySelectorAll('[data-hub-arc="top"]').forEach(path => path.setAttribute('d', mark.top));
      hub.current.querySelectorAll('[data-hub-arc="bottom"]').forEach(path => path.setAttribute('d', mark.bottom));
      hub.current.style.setProperty('--source-dot-scale', String(h.dotSource));
      hub.current.style.setProperty('--agent-dot-scale', String(h.dotAgent));
      const { size } = hubControlGeometry(h.Re);
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
        el.style.transform = `translate(${v.x - NODE_R}px, ${v.y - NODE_R}px) scale(${v.scale * v.size / (n.group ? 42 : NODE_R * 2)})`;
        el.style.opacity = String(v.op);
        el.style.setProperty('--path-emphasis', String(Math.max(0, Math.min(1, v.emphasis))));
        el.inert = !a.live.get(key)?.alive || v.op < 0.02;
      } else if (el) {
        el.style.opacity = '0'; el.inert = true;
      }
      const control = arcControls.current.get(key), interactive = !!a.live.get(key)?.alive && !n.group && (v?.presence ?? 0) > .02;
      if (v && control) {
        control.place(portrait ? { kind: 'line',
          start: { x: v.x - n.side * v.radius, y: v.y - 14 }, end: { x: v.x - n.side * v.radius, y: v.y + 14 }, outward: { x: -n.side, y: 0 } }
          : { kind: 'arc', x: v.x, y: v.y, radius: v.radius, lo: v.alo, hi: v.ahi, side: n.side }, interactive);
        if (interactive) {
          const branches = [
            ...latest.current.nodes.filter(child => child.side === n.side && child.parent === n.id && !child.group).flatMap(child => {
              const c = a.values(nodeKey(child.side, child.id));
              return c && c.presence > .02 ? [{ x: c.x - (portrait ? -n.side : n.side) * c.size * c.scale / 2, y: c.y, halfHeight: c.size * c.scale / 2 }] : [];
            }),
            ...latest.current.tasks.filter(task => task.side === n.side && task.parent === n.id && !n.selected).flatMap(task => {
              const c = a.values(taskKey(task.side, task.id));
              return c && c.op > .02 ? [{ x: c.x + (((portrait || n.side === -1) ? 1 : 0) - c.anchor) * c.width, y: c.y, halfHeight: c.height / 2 }] : [];
            }),
          ];
          const outward: Side = portrait ? (n.side === 1 ? -1 : 1) : n.side;
          actionRegions.current.set(key, arcActionRegion({ x: v.x, y: v.y, radius: v.size * v.scale / 2, arcRadius: v.radius }, branches, outward));
        }
      }
    }
    const pendingFocus = pendingGroupFocus.current;
    if (pendingFocus) {
      const element = elements.current.get(pendingFocus);
      if (element && !element.inert) {
        pendingGroupFocus.current = null;
        element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
      }
    }
    for (const t of latest.current.allTasks) {
      const key = taskKey(t.side, t.id), v = a.values(key), el = elements.current.get(key);
      if (!el) continue;
      el.style.opacity = String(v ? v.op : 0);
      const hidden = latest.current.nodes.some(n => n.side === t.side && n.selected);
      el.style.pointerEvents = a.live.get(key)?.alive && !hidden && (v?.op ?? 0) > .02 ? "" : "none";
      el.inert = !a.live.get(key)?.alive || hidden || (v?.op ?? 0) <= .02;
      el.setAttribute('aria-hidden', String(el.inert));
      el.style.visibility = (v?.op ?? 0) <= .02 ? 'hidden' : '';
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
    if (blend > 0.001) {
      const open = latest.current.allNodes.find(n => n.group && latest.current.expandedGroups.has(n.id));
      portraitPainter.current?.paint(a, latest.current.nodes, latest.current.tasks, rect, open ? { ...open.group!, label: open.label } : undefined);
    }
    if (blend < 0.999) painter.current?.paint(a, latest.current.nodes, latest.current.tasks, rect,
      latest.current.guides ? layout.current : null);
    updateActionPointer();
    pets.current?.layout();
  }, [boundary, updateActionPointer]);
  const tick = useCallback((time: number) => {
    frame.current = 0;
    const dt = Math.min(0.064, lastTime.current ? (time - lastTime.current) / 1000 : 1 / 60);
    const moving = animator.current.step(dt * (latest.current.slow ? 0.25 : 1), !!latest.current.reduced);
    lastTime.current = time; paint();
    if (moving) frame.current = requestAnimationFrame(tick);
    else {
      lastTime.current = 0;
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
    // The fixed slot contributes one available horizontal boundary to the existing solver.
    const { sizes, margin } = readLayerTokens();
    const reservedWidth = Math.min(sizes.m, innerWidth - 2 * margin);
    if (selected) sc.panel = { side: selected.side, selected: selected.id,
      edge: selected.side === 1 ? innerWidth - reservedWidth - margin - origin.current.x : margin + reservedWidth - origin.current.x,
      overlay: latest.current.panelExpanded || innerWidth < 760 || innerHeight > innerWidth };
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
    const { params, left, right, expandedGroups } = latest.current;
    const plan = latest.current.compacted;
    if (orientation.current === 'portrait') {
      const solved = solvePortrait(sc, params);
      const measured = compactRoots(left, right, sc, 'portrait', params, solved);
      const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(id => b.has(id));
      if (!same(measured.left, portraitPlanRef.current.left) || !same(measured.right, portraitPlanRef.current.right)) setPortraitPlan(measured);
    }
    const result = compactLayout(sc, plan, expandedGroups, params, orientation.current);
    // Folded branches and unread source leaves retain an actionable outer arc.
    for (const wing of result.wings) for (const node of wing.nodes) {
      if (node.arc) continue;
      const full = latest.current.fullNodes.find(n => n.side === wing.side && n.id === node.id);
      const view = latest.current.nodes.find(n => n.side === wing.side && n.id === node.id);
      if (full && (unreadUnder(full).length || view?.collapsed && (full.children?.length || full.tasks.length))) {
        node.arc = { R: node.size / 2 * node.scale + latest.current.params.arcGap, lo: -14, hi: 14 };
      }
    }
    if (activeDrag) {
      const wing = result.wings.find(w => w.side === activeDrag.side)!;
      if (activeDrag.kind === 'node') {
        const node = wing.nodes.find(n => n.id === activeDrag.id);
        if (node) {
          const dx = activeDrag.x - node.x;
          if (node.taskBusX !== undefined) node.taskBusX += dx;
          if (node.childBusX !== undefined) node.childBusX += dx;
          node.x = activeDrag.x; node.y = activeDrag.y;
        }
      } else {
        const task = wing.tasks.find(t => t.id === activeDrag.id);
        if (task) { task.x = activeDrag.x; task.y = activeDrag.y; }
      }
    }
    return result;
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
    const membership = new Map(latest.current.allNodes.filter(n => n.groupMember).map(n => [nodeKey(n.side, n.id), nodeKey(n.side, n.groupMember!)]));
    animator.current.setTargets(layout.current, d?.active ? d : null, membership);
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
    orientation.current = resolveOrientation(orientation.current, topologyLayout.get(), env.windowWidth ?? innerWidth, env.windowHeight ?? innerHeight);
    orientationSource.current = topologyLayout.get() === 'auto' ? 'auto' : 'manual';
    
    orientationPending.current = false;
    setViewport(old => old.orientation === orientation.current ? old : { ...old, orientation: orientation.current });
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
        && t.parentTaskId === latest.current.tasks.find(t => t.side === side && t.id === id)?.parentTaskId
        && (t.state === "needsYou") === (latest.current.tasks.find(t => t.side === side && t.id === id)?.state === "needsYou"));
    drag.current = { kind, side, id, parent, x: v.x, y: v.y, pointer: event.pointerId, startClientX: event.clientX, startClientY: event.clientY,
      grabX: event.clientX - origin.current.x - v.x, grabY: event.clientY - origin.current.y - v.y, order: candidates.map(n => n.id), active: false, control,
      initialOrder: candidates.map(n => n.id), target: button, slot: event.currentTarget, key };
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
    if (d.active && !cancelled && (d.order.length !== d.initialOrder.length || d.order.some((id, index) => id !== d.initialOrder[index]))) {
      if (d.kind === "node") latest.current.onReorderNodes(d.side, d.order);
      else latest.current.onReorderTasks(d.side, d.parent!, d.order);
    }
    if (orientationPending.current && orientationTimer.current === null) evaluateOrientation.current();
    target();
  };
  const suppressClick = (event: MouseEvent, key: string) => {
    if (event.detail !== 0 && suppressedClick.current === key) { event.preventDefault(); event.stopPropagation(); }
  };
  useImperativeHandle(ref, () => ({ memberLayerPointer(event) {
    const selected = latest.current.nodes.find(n => n.selected && n.groupMember && latest.current.expandedGroups.has(n.groupMember));
    if (selected) insidePointers.current.add(event);
  }, panelFrame(rect) {
    // DOMRect dimensions are prototype accessors, not enumerable own properties.
    panel.current = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    paint();
  } }), [paint]);
  useLayoutEffect(() => { setRetained(latest.current.allTasks); setRetainedNodes(latest.current.allNodes); }, [inputLeft, inputRight, collapsed]);
  useLayoutEffect(() => { target(); });
  useLayoutEffect(() => {
    const present = (item: typeof hover) => {
      if (!item || groups.some(g => g.side === item.side && g.id === item.id && expandedGroups.has(g.id))) return true;
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
    portraitPainter.current = new PortraitPainter(portraitSvg.current!, prefix, changeHover, markGroupPointer);
    painter.current = new TopologyPainter(svg.current, prefix, changeHover, markGroupPointer);
    const container = boundary.current;
    const measure = () => {
      const env = envOverrides();
      const vw = env.windowWidth == null ? container.clientWidth : env.windowWidth - (innerWidth - container.clientWidth);
      const vh = env.windowHeight == null ? container.clientHeight : env.windowHeight - (innerHeight - container.clientHeight);
      if (vw <= 0 || vh <= 0) return;
      size.current = { vw, vh };
      setViewport(old => old.vw === vw && old.vh === vh ? old : { ...old, vw, vh });
      const rect = graph.current!.getBoundingClientRect();
      origin.current = { x: rect.x, y: rect.y }; target(); scheduleOrientation();
    };
    const scroll = () => {
      const rect = graph.current!.getBoundingClientRect();
      const dx = origin.current.x - rect.x, dy = origin.current.y - rect.y;
      origin.current = { x: rect.x, y: rect.y };
      if (drag.current?.active) { drag.current.x += dx; drag.current.y += dy; target(); }
      else if (latest.current.panelKey) target();
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
    onPointerLeave={event => { if (event.pointerType !== 'touch') clearInteraction(); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) clearInteraction(); }}
    onPointerDownCapture={event => { suppressedClick.current = null; if (!(event.target as Element).closest('.topology-arc-actions')) revealActions(null); }}
    onPointerMoveCapture={event => {
      if (event.pointerType !== 'touch') { actionPointer.current = { x: event.clientX, y: event.clientY }; updateActionPointer(); }
      if (drag.current?.control) moveDrag(event);
    }}
    onPointerUpCapture={event => { if (drag.current?.control) finishDrag(event); }}
    onPointerCancelCapture={event => { if (drag.current?.control) finishDrag(event, true); }}
    onLostPointerCaptureCapture={event => { if (drag.current?.control) finishDrag(event, true); }}
    onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)} onPointerCancel={event => { finishDrag(event, true); clearInteraction(); }}
    onLostPointerCapture={event => finishDrag(event, true)}
    onKeyDownCapture={event => { actionPointer.current = null; pointerActionOwner.current = null; if (event.key === "Escape" && drag.current) {
      const d = drag.current; drag.current = null; delete d.slot.dataset.dragging;
      if (d.target.hasPointerCapture(d.pointer)) d.target.releasePointerCapture(d.pointer);
      if (orientationPending.current && orientationTimer.current === null) evaluateOrientation.current();
      target(); event.preventDefault(); event.stopPropagation();
    } }}>
    <PetLayer ref={pets} geometry={petGeometry} />
    <svg ref={svg} className="topology-wires" aria-hidden="true" />
    <svg ref={portraitSvg} className="topology-wires portrait-wires" aria-hidden="true" />
    <div ref={deviceSummary} className="topology-device-summary"><DeviceSummary /></div>
    <div ref={hub} className="topology-hub"
      onPointerMove={event => setHubInteraction((event.target as Element).closest('.hub-source') ? 'source' : (event.target as Element).closest('.hub-agent') ? 'agent' : 'hub')}
      onPointerLeave={() => setHubInteraction(undefined)}
      onFocusCapture={event => setHubInteraction((event.target as Element).closest('.hub-source') ? 'source' : (event.target as Element).closest('.hub-agent') ? 'agent' : 'hub')}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHubInteraction(undefined); }}>{brand}</div>
    {([-1, 1] as const).map(side => {
      const closed = closedWing === side;
      if (!(side === -1 ? inputLeft : inputRight).length && !closed) return null;
      const key = `wing:${side}`, unread = (side === -1 ? inputLeft : inputRight).flatMap(unreadUnder);
      return <ArcActions key={key} side={side} label={t(side === -1 ? 'topology.sourceSide' : 'topology.agentSide')}
        ref={control => { if (control) arcControls.current.set(key, control); else arcControls.current.delete(key); }}
        open={revealed === key} collapsed={closed} canCollapse={closed || !!(side === -1 ? inputRight : inputLeft).length}
        unread={!!unread.length} onRead={onMarkRead ? () => onMarkRead(unread) : undefined}
        onOpen={open => revealActions(open ? key : null)} onDismiss={() => hub.current?.querySelector<HTMLButtonElement>(side === -1 ? '.hub-source' : '.hub-agent')?.focus({ preventScroll: true })}
        onCollapse={() => {
          if (!closed) onCollapseSide?.(side);
          topologyCollapsed.set(old => ({ ...old, [`wing:${side}`]: !closed, [`wing:${-side}`]: false }));
          setOpenedGroup(null); clearInteraction();
        }} />;
    })}
    {accountsEnabled && allNodes.filter(node => !node.group).map(node => {
      const full = fullNodes.find(full => full.side === node.side && full.id === node.id);
      if (!full) return null;
      const unread = unreadUnder(full), canCollapse = !!full.children?.length || !!full.tasks.length;
      if (!canCollapse && !unread.length) return null;
      const key = nodeKey(node.side, node.id), closed = collapsed[key] === true;
      return <ArcActions key={key} onPointerDownCapture={event => markGroupPointer(event.nativeEvent, node)} side={node.side} label={node.label ?? node.id} open={revealed === key} collapsed={closed} canCollapse
        ref={control => { if (control) arcControls.current.set(key, control); else arcControls.current.delete(key); }}
        onOpen={open => { revealActions(open ? key : null); if (open) setHover({ side: node.side, id: node.id }); }} onDismiss={() => restoreNodeFocus(key)}
        unread={!!unread.length} onRead={onMarkRead ? () => onMarkRead(unread) : undefined}
        onCollapse={canCollapse ? () => topologyCollapsed.set(old => ({ ...old, [key]: !closed })) : undefined} />;
    })}
    {allNodes.map(n => <div key={nodeKey(n.side, n.id)} ref={el => { const key = nodeKey(n.side, n.id); if (el) elements.current.set(key, el); else elements.current.delete(key); }}
      data-agent-node={!n.group && n.side === 1 ? n.platform ?? n.id : undefined} data-source-node={!n.group && n.side === -1 ? n.platformRoot ? n.id : n.sourceIds?.[0] ?? n.id : undefined}
      data-agent-platform={n.side === 1 && !n.account ? n.platform : undefined}
      data-source-platform={n.side === -1 ? n.platform : undefined}
      data-account-id={n.accountId} data-topology-group={n.group?.id}
      className={`topology-node ${n.group ? "topology-group-node" : ""} ${n.side === 1 ? "agents" : "sources"}`} data-highlighted={n.selected || undefined} data-reorderable={n.reorderable || undefined}
      onPointerEnter={() => changeHover({ side: n.side, id: n.id })} onPointerLeave={() => changeHover(null)} onPointerCancel={() => changeHover(null)}
      onFocusCapture={() => setFocus({ side: n.side, id: n.id })} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { changeHover(null); } }}
      onKeyDownCapture={event => {
        if (!accountsEnabled || !n.reorderable || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        const peers = nodes.filter(p => p.side === n.side && p.parent === n.parent && p.reorderable && !!p.account === !!n.account && (!n.account || p.account && p.platform === n.platform));
        const index = peers.findIndex(p => p.id === n.id), next = index + (event.key === 'ArrowUp' ? -1 : 1);
        if (next >= 0 && next < peers.length) { const ids = peers.map(p => p.id); [ids[index], ids[next]] = [ids[next], ids[index]]; onReorderNodes(n.side, ids); }
        event.preventDefault(); event.stopPropagation();
      }}
      onPointerDownCapture={event => markGroupPointer(event.nativeEvent, n)}
      onPointerDown={n.reorderable ? event => startDrag(event, "node", n.side, n.id) : undefined}
      onClickCapture={event => suppressClick(event, nodeKey(n.side, n.id))}>{n.content}{accountsEnabled && !n.group && (() => {
        const full = fullNodes.find(p => p.side === n.side && p.id === n.id);
        if (!full || !full.children?.length && !full.tasks.length) return null;
        const closed = collapsed[nodeKey(n.side, n.id)] === true;
        const collect = (node: NodeView): TaskView[] => [...node.tasks, ...(node.children ?? []).flatMap(collect)];
        const ownTasks = collect(full);
        const sourceAccounts = new Set([full.accountId, ...(full.children ?? []).map(c => c.accountId)].filter(Boolean));
        const hiddenTasks = n.side === 1 ? ownTasks : fullNodes.filter(p => p.side === 1).flatMap(p => p.tasks).flatMap(task => task.members?.map(member => ({ ...task, ...member, count: 1 })) ?? [task]).filter(t => sourceAccounts.has(t.origin?.accountId) || !!t.origin?.sourceId && full.sourceIds?.includes(t.origin.sourceId));
        const count = hiddenTasks.reduce((sum, task) => sum + (task.count ?? 1), 0);
        return (closed || panelKey?.startsWith('agent:') && n.side === 1 && !n.selected && !n.children?.length) && count > 0
          ? <span className="agent-task-count" data-attention={hiddenTasks.some(t => t.state === 'needsYou' || t.pending) || undefined} aria-label={t('topology.hiddenTasks', { count })}>{count}</span> : null;
      })()}</div>)}
    {allTasks.map(t => <div key={taskKey(t.side, t.id)} ref={el => { const key = taskKey(t.side, t.id); if (el) elements.current.set(key, el); else elements.current.delete(key); }}
      id={`${prefix}-task-${encodeURIComponent(t.id)}`} role={t.parentTaskId ? 'group' : undefined}
      aria-details={t.parentTaskId ? `${prefix}-task-${encodeURIComponent(t.parentTaskId)}` : undefined} data-parent-task={t.parentTaskId}
      className="activity-slot" data-highlighted={t.selected || undefined} data-reorderable={t.reorderable || undefined} data-activity-queue={t.activityQueue}
      onPointerEnter={() => changeHover({ side: t.side, id: t.id, task: true })} onPointerLeave={() => changeHover(null)} onPointerCancel={() => changeHover(null)}
      onFocusCapture={() => setFocus({ side: t.side, id: t.id, task: true })} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) changeHover(null); }}
      onPointerDownCapture={event => {
        markGroupPointer(event.nativeEvent, { ...t, task: true });
        if (t.reorderable && (event.target as Element).closest("[data-topology-control]")) startDrag(event, "task", t.side, t.id, t.parent, true);
      }}
      onPointerDown={t.reorderable ? event => startDrag(event, "task", t.side, t.id, t.parent) : undefined}
      onClickCapture={event => suppressClick(event, taskKey(t.side, t.id))}>{t.content}</div>)}
  </div>;
}

import { deviceTasks } from '../devices/tasks';
import { name as agentName } from '../state/agents';
import { connector } from '../state/connector';
import { accounts as accountStore } from '../state/accounts';
import { accountOwns } from '../accountPresentation';
import { layers } from '../state/layers';
import PetLayer, { type PetLayerHandle, type PetGeometry } from '../pets/PetLayer';
import { participantPost, petPath, wanderPost, type Rect } from '../pets/geometry';
import { DropdownMenu } from 'radix-ui';
import { Bot } from 'lucide-react';
import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Laptop, Monitor } from 'lucide-react';
import { BrandMark, Icon } from '../components/ui';
import GraphNode from '../components/GraphNode';
import SourceIcon from '../components/SourceIcon';
import { TopologyGroup } from '../components/ui/TopologyGroup';
import { nodeTaskState, type HomepageTask } from '../state/activityModel';
import { focusNodeTasks } from '../state/homepage';
import { deviceLinkEnabled, deviceSnapshot, deviceView, pairedDevices } from '../devices/state';
import { icons } from '../state/agents';
import { useNow } from '../state/hooks';
import { iconWindows } from '../subscriptions/AgentQuotaIcon';
import { quotaDisplay, quotaValue } from '../subscriptions/displayPreferences';
import { quotaElapsed } from '../subscriptions/quotaTiming';
import { quotaColor } from '../subscriptions/presentation';
import type { ProviderSnapshot } from '../subscriptions/types';
import type { AgentIconReading } from '../components/ui/agent-icon';
import { observeTopology } from '../acceptance';
import { nodeKey, layoutTopology, topologyRoute, topologyPath } from './layout';
import type { Side } from './geometry';
import type { PaintNode } from './render';
import { t } from '../i18n';
import './topology.css';
export interface NodeView extends Omit<PaintNode, 'side'> {
  content: ReactNode;
  children?: NodeView[];
  deviceId?: string;
  remoteAgent?: string;
  upstreamSourceId?: string;
  capsuleMark?: ReactNode;
  platformRoot?: boolean;
  account?: boolean;
  accountId?: string;
  platform?: string;
  platformLabel?: string;
  sourceIds?: string[];
  icon?: ReactNode;
  selectedAccountId?: string | null;
  quota?: ProviderSnapshot;
  sourceProduct?: string;
  sourceProductLabel?: string;
}
type PositionedNode = NodeView & { side: Side; x: number; y: number; parent?: string; deviceId?: string };
function StaticNode({ node, tasks, compact, onWidth }: { node: PositionedNode; tasks: HomepageTask[]; compact: boolean; onWidth: (key: string, width: number) => void }) {
  const now = useNow(), display = quotaDisplay.use();
  const provider = node.quota, readings: AgentIconReading[] = provider ? iconWindows(provider, now, node.platform !== 'claude').map(window => ({
    id: window.id, label: window.label, value: quotaValue(window)!, color: quotaColor(window, provider, now), elapsed: quotaElapsed(window, provider, now),
  })) : [];
  const key = nodeKey(node.side, node.id);
  const widthChanged = useCallback((width: number) => onWidth(key, width), [onWidth, key]);
  const own = tasks.filter(task => {
    if (node.deviceId && node.side === 1) return task.deviceId === node.deviceId && (!node.remoteAgent || task.agent === node.remoteAgent);
    if (node.deviceId) return task.controllerDeviceId === node.deviceId || !!node.sourceIds?.some(source => task.sourceIds.includes(source));
    if (node.upstreamSourceId) return task.upstreamSourceId === node.upstreamSourceId;
    if (task.deviceId) return false;
    if (node.side === -1) return !!node.sourceIds?.some(source => task.sourceIds.includes(source));
    return task.agent === node.platform && (!node.accountId || accountStore.get().items.some(account => account.id === node.accountId && accountOwns(account, task.accountId)));
  });
  const state = nodeTaskState(own, node.deviceId ? node.state === 'inactive' ? 'offline' : 'online' : undefined);
  if (!isValidElement(node.content)) return node.content;
  const graphic = node.deviceId ? undefined : node.side === 1 ? <BrandMark markup={icons[node.platform ?? node.id]} size={28} /> : <SourceIcon platform={node.platform ?? node.id} panelVisual />;
  return cloneElement(node.content as React.ReactElement<React.ComponentProps<typeof GraphNode>>, {
    capsule: state, neutralRing: !!node.deviceId, compact, wing: node.side === -1 ? 'left' : 'right', capsuleMark: node.capsuleMark ?? graphic, readings, used: display === 'used', hideLabel: false,
    onWidth: widthChanged, onTasks: () => focusNodeTasks({ id: node.id, label: node.label ?? node.platformLabel ?? node.id,
      agent: node.remoteAgent ?? (node.side === 1 && !node.deviceId ? node.platform ?? node.id : undefined), accountId: node.accountId,
      upstreamSourceId: node.upstreamSourceId, sourceIds: node.side === -1 && !node.upstreamSourceId ? node.sourceIds : undefined, deviceId: node.side === 1 ? node.deviceId : undefined }),
  });
}
export default function Topology({ left, right, brand, tasks = [], onAddAgent }: {
  onAddAgent: () => void;
  left: NodeView[]; right: NodeView[]; brand: ReactNode; tasks?: HomepageTask[];

}) {
  const sourceSnapshot = connector.use().sources;
  const enabled = deviceLinkEnabled.use(), snapshot = deviceSnapshot.use(), deviceSelection = deviceView.use();
  const remote = deviceTasks.use();
  const openDevice = (selection: ReturnType<typeof deviceView.get>) => {
    const current = deviceView.get();
    const same = current.detail === selection.detail && current.agent === selection.agent && current.upstreamSource === selection.upstreamSource;
    layers.switchPanel(() => deviceView.set(selection), same);
  };
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const pets = useRef<PetLayerHandle>(null);
  const graph = useRef<HTMLDivElement>(null), pan = useRef<HTMLDivElement>(null);
  const focusMembers = useRef<string | null>(null);
  const restore = useRef<string | null>(null);
  const setWidth = useCallback((key: string, width: number) => setWidths(old => Math.abs((old[key] ?? 48) - width) < .01 ? old : { ...old, [key]: width }), []);
  useEffect(() => { const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const controller = enabled && snapshot?.controller;
  const upstreamNodes: NodeView[] = controller && controller.showUpstreamSources ? (controller.upstreamSources ?? []).map(source => ({
    id: `upstream:${source.sourceId}`, upstreamSourceId: source.sourceId, platform: source.controlSource ?? 'custom', label: source.sourceLabel ?? source.sourceId,
    state: 'normal', selected: deviceSelection.upstreamSource === source.sourceId, attention: false,     content: <GraphNode label={source.sourceLabel ?? source.sourceId} state="normal" caption={<span className="graph-node-name">{source.sourceLabel ?? source.sourceId}</span>}
      onOpen={() => openDevice({ side: 'member', detail: controller.deviceId, upstreamSource: source.sourceId })}><SourceIcon platform={source.controlSource ?? 'custom'} panelVisual /></GraphNode>,
  })) : [];
  const sourceRoots: NodeView[] = controller ? [{ id: `device:${controller.deviceId}`, deviceId: controller.deviceId, label: controller.name, state: 'normal',
    selected: deviceSelection.detail === controller.deviceId, attention: false,     sourceIds: sourceSnapshot.filter(source => source.ingressId === `peer:${controller.deviceId}`).map(source => source.id),
    content: <GraphNode label={controller.name} state="normal" caption={<span className="graph-node-name">{controller.name}</span>} panelExpanded={deviceSelection.detail === controller.deviceId}
      onOpen={() => openDevice({ side: 'member', detail: controller.deviceId })}><Icon icon={Monitor} size={28} /></GraphNode>, children: upstreamNodes }] : left;
  const members: NodeView[] = enabled ? pairedDevices(snapshot).map(device => {
    const inventory = remote[device.id]?.snapshot?.availableAgents.filter(agent => agent.available !== false && agent.enabled !== false && agent.installed !== false) ?? [];
    const single = inventory.length === 1 ? inventory[0] : undefined;
    const state = device.state === 'online' ? 'normal' as const : 'inactive' as const;
    const graphic = <span className="device-node-graphic">{single ? <BrandMark markup={icons[single.agent]} size={28} /> : <Icon icon={Laptop} size={28} />}
      <span className="device-node-status" role="img" aria-label={t(device.state === 'online' ? 'device.online' : 'device.offline')} data-online={device.state === 'online'} />{single && <span className="device-node-badge"><Icon icon={Laptop} size={10} /></span>}</span>;
    const label = single ? `${device.name} · ${agentName(single)}` : device.name;
    const managingDevice = deviceSelection.detail === device.id && !deviceSelection.agent;
    const children: NodeView[] = single || managingDevice ? [] : inventory.map(agent => ({
      id: `device:${device.id}:agent:${agent.agent}`, deviceId: device.id, remoteAgent: agent.agent, platform: agent.agent, label: agentName(agent),
      state, selected: deviceSelection.detail === device.id && deviceSelection.agent === agent.agent, attention: false,       icon: <BrandMark markup={icons[agent.agent]} size={28} />,
      content: <GraphNode label={`${device.name} · ${agentName(agent)}`} state={state} caption={<span className="graph-node-name">{agentName(agent)}</span>}
        panelExpanded={deviceSelection.detail === device.id && deviceSelection.agent === agent.agent}
        onOpen={() => openDevice({ side: 'controller', detail: device.id, agent: agent.agent })}><BrandMark markup={icons[agent.agent]} size={28} /></GraphNode>,
    }));
    return { id: `device:${device.id}`, deviceId: device.id, remoteAgent: single?.agent, label, state, selected: managingDevice,
      attention: false, capsuleMark: graphic, icon: graphic, children,
      content: <GraphNode label={label} state={state} caption={<span className="graph-node-name">{label}<small>{device.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : t('device.offline')}</small></span>}
        panelExpanded={managingDevice} onOpen={() => openDevice({ side: 'controller', detail: device.id })}>{graphic}</GraphNode>,
    };
  }) : [];
  const executorRoots = [...right, ...members];
  const scene = layoutTopology(sourceRoots, executorRoots, { ...viewport, expanded: openGroups });
  const { nodes, groups, compact, hub, add, width: sceneWidth, height: maxY } = scene;
  const hubX = hub.x, hubY = hub.y, hubSize = hub.size;
  const allPositions = [...nodes, ...groups.map(group => group.node)];
  const wires = allPositions.map(node => {
    const parent = nodes.find(parent => parent.id === node.parent && parent.side === node.side);
    const parentWidth = parent ? widths[nodeKey(parent.side, parent.id)] ?? 48 : 48;
    return { key: nodeKey(node.side, node.id), side: node.side, d: topologyPath(topologyRoute(node, parent, hub, compact, parentWidth)) };
  });
  if (enabled) wires.push({ key: 'add', side: 1, d: topologyPath(topologyRoute({ ...add, side: 1 }, undefined, hub, compact, 48, true)) });
  const current = useRef({ nodes, wires }); current.current = { nodes, wires };
  useEffect(() => observeTopology(() => ({ orientation: compact ? 'portrait' : 'landscape', source: 'auto', orientationPending: false,
    origin: graph.current?.getBoundingClientRect(), size: viewport, panel: null, groups: [], tasks: [],
    nodes: current.current.nodes.map(({ content: _content, children: _children, icon: _icon, capsuleMark: _capsuleMark, ...node }) => ({ ...node, position: { x: node.x, y: node.y, size: 48, scale: 1, op: 1 } })), paths: current.current.wires,
  })), [compact, viewport]);
  useEffect(() => {
    if (!openGroups.size) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role=dialog]')) return;
      event.preventDefault(); restore.current = [...openGroups].at(-1)!; setOpenGroups(new Set());
    };
    const outside = (event: PointerEvent) => {
      if (layers.get().length || !(event.target instanceof Element)) return;
      const group = [...openGroups].at(-1)!;
      if (event.target.closest(`[data-group-owner="${CSS.escape(group)}"], [data-group="${CSS.escape(group)}"]`)) return;
      setOpenGroups(new Set());
    };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [openGroups]);
  useLayoutEffect(() => {
    if (focusMembers.current) { graph.current?.querySelector<HTMLElement>(`[data-group-owner="${CSS.escape(focusMembers.current)}"] button`)?.focus({ preventScroll: true }); focusMembers.current = null; }
    if (restore.current) { graph.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(restore.current)}"] button`)?.focus(); restore.current = null; } }, [openGroups]);
  const petGeometry = (): PetGeometry => {
    const bounds = { x: sceneWidth, y: maxY, top: 0 };
    const obstacles: Rect[] = nodes.map(node => ({ x: node.x - 24, y: node.y - 24,
      width: widths[nodeKey(node.side, node.id)] ?? 48, height: 80 }));
    return { bounds, taskFrame: () => undefined, taskPresent: () => false, task: () => undefined,
      participant: (participant, accountId, size) => {
        const node = nodes.find(node => !node.deviceId && node.side === (participant.kind === 'source' ? -1 : 1)
          && (node.id === participant.nativeId || node.sourceIds?.includes(participant.nativeId) || node.platform === participant.nativeId)
          && (!accountId || node.accountId === accountId));
        if (!node || !size) return;
        return participantPost({ x: node.x - 24, y: node.y - 24, width: 48, height: 80 }, { x: hubX, y: hubY }, obstacles, bounds, size);
      },
      route: (from, to, size, occupied = []) => petPath(from, to, bounds, [...obstacles, ...occupied], size),
      wander: (from, size, occupied) => wanderPost(from, bounds, [...obstacles, ...occupied], size),
    };
  };
  useLayoutEffect(() => { pets.current?.layout(); }, [sceneWidth, maxY, widths, openGroups, left, right]);
  return <div ref={pan} className="static-topology-pan" role="region" aria-label={t('homepage.topology')} tabIndex={0}>
    <div ref={graph} className="static-topology-scene" style={{ width: sceneWidth, height: maxY }}>
      <svg className="static-topology-wires" width={sceneWidth} height={maxY} aria-hidden="true"><g fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {wires.map(wire => <path key={wire.key} d={wire.d} stroke={wire.side === -1 ? 'var(--topology-source)' : 'var(--topology-agent)'} opacity={.55} />)}
      </g></svg>
      <div className="topology-hub static-topology-hub" style={{ left: hubX - hubSize / 2, top: hubY - hubSize / 2, width: hubSize, height: hubSize, '--hub-dot-size': `${hubSize * 20 / 92}px` } as React.CSSProperties}>{brand}</div>
      {enabled && <div className="static-topology-add" style={{ left: add.x - 14, top: add.y - 14 }}>
        <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="topology-add-endpoint" data-device-add data-panel-anchor aria-label={t('homepage.add')}><span /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="task-card-menu" sideOffset={8}>
            <DropdownMenu.Item onSelect={onAddAgent}><Icon icon={Bot} />{t('addAgent')}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => deviceView.set({ side: 'controller', dialog: 'pair' })}><Icon icon={Laptop} />{t('device.add')}</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => openDevice({ side: 'member', detail: 'pairing' })}><Icon icon={Monitor} />{t('device.thisDevice')}</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>}
      {nodes.map(node => <div key={nodeKey(node.side, node.id)} className="static-topology-node" data-node={node.id} data-group-owner={node.parent} data-offline={node.state === 'inactive' && !!node.deviceId || undefined}
        style={{ left: node.x - 24, top: node.y - 24 }}><StaticNode node={node} tasks={tasks} compact={compact} onWidth={setWidth} /></div>)}
      {groups.map(group => <div key={group.key} className="static-topology-node" data-group={group.node.parent} data-wing={group.node.side === -1 ? 'left' : 'right'} style={{ left: group.node.x - 24, top: group.node.y - (compact ? 24 : 20) }}>
        <TopologyGroup label={t('homepage.accounts', { count: group.members.length })} members={group.members.map(member => ({ brand: member.platform ?? member.id, mark: member.icon ?? <BrandMark markup={icons[member.platform ?? member.id]} size={28} />, quota: member.quota }))}
          layout={compact ? group.node.side === -1 ? 'source' : 'agent' : 'vertical'} aria-expanded={false}
          onClick={event => { if (event.detail === 0) focusMembers.current = group.node.parent!; setOpenGroups(old => new Set([...old, group.node.parent!])); }} />
      </div>)}
      <PetLayer ref={pets} geometry={petGeometry} />
    </div>
  </div>;
}

import { deviceTasks } from '../devices/tasks';
import { name as agentName } from '../state/agents';
import { connector } from '../state/connector';
import { accounts as accountStore } from '../state/accounts';
import { accountOwns } from '../accountPresentation';
import { layers } from '../state/layers';
import { cloneElement, isValidElement, useCallback, useMemo } from 'react';
import { Laptop, Monitor } from 'lucide-react';
import { BrandMark, Icon } from '../components/ui';
import GraphNode from '../components/GraphNode';
import SourceIcon from '../components/SourceIcon';
import { nodeTaskState, type HomepageTask } from '../state/activityModel';
import { focusNodeTasks } from '../state/homepage';
import { deviceLinkEnabled, deviceSnapshot, deviceView, pairedDevices } from '../devices/state';
import { icons } from '../state/agents';
import { useNow } from '../state/hooks';
import { iconWindows } from '../subscriptions/AgentQuotaIcon';
import { quotaDisplay, quotaValue } from '../subscriptions/displayPreferences';
import { quotaElapsed } from '../subscriptions/quotaTiming';
import { quotaColor } from '../subscriptions/presentation';
import type { AgentIconReading } from '../components/ui/agent-icon';
import { nodeKey } from './animate';
import type { NodeView } from './Topology';
import type { Side } from './solve';
import { t } from '../i18n';

export function tasksForNode(node: NodeView & { side: Side }, tasks: HomepageTask[]) {
  return tasks.filter(task => {
    if (node.deviceId && node.side === 1) return task.deviceId === node.deviceId && (!node.remoteAgent || task.agent === node.remoteAgent);
    if (node.deviceId) return task.controllerDeviceId === node.deviceId || !!node.sourceIds?.some(source => task.sourceIds.includes(source));
    if (node.upstreamSourceId) return task.upstreamSourceId === node.upstreamSourceId;
    if (task.deviceId) return false;
    if (node.side === -1) return !!node.sourceIds?.some(source => task.sourceIds.includes(source));
    return task.agent === node.platform && (!node.accountId || accountStore.get().items.some(account => account.id === node.accountId && accountOwns(account, task.accountId)));
  });
}
export function capsuleState(node: NodeView & { side: Side }, tasks: HomepageTask[]) {
  if (node.hasChildren || node.children?.length) return nodeTaskState([]);
  return nodeTaskState(tasksForNode(node, tasks), node.deviceId ? node.state === 'inactive' ? 'offline' : 'online' : undefined);
}
type PositionedNode = NodeView & { side: Side; parent?: string };
export function CapsuleNode({ node, tasks, compact, onWidth }: { node: PositionedNode; tasks: HomepageTask[]; compact: boolean; onWidth: (key: string, width: number) => void }) {
  const now = useNow(), display = quotaDisplay.use();
  const provider = node.quota, readings: AgentIconReading[] = provider ? iconWindows(provider, now, node.platform !== 'claude').map(window => ({
    id: window.id, label: window.label, value: quotaValue(window)!, color: quotaColor(window, provider, now), elapsed: quotaElapsed(window, provider, now),
  })) : [];
  const key = nodeKey(node.side, node.id);
  const widthChanged = useCallback((width: number) => onWidth(key, width), [onWidth, key]);
  const state = capsuleState(node, tasks);
  if (!isValidElement(node.content) || node.content.type !== GraphNode) return node.content;
  const graphic = node.deviceId ? undefined : node.side === 1 ? <BrandMark markup={icons[node.platform ?? node.id]} size={28} /> : <SourceIcon platform={node.platform ?? node.id} panelVisual />;
  return cloneElement(node.content as React.ReactElement<React.ComponentProps<typeof GraphNode>>, {
    capsule: state, neutralRing: !!node.deviceId, compact, wing: node.side === -1 ? 'left' : 'right', capsuleMark: node.capsuleMark ?? graphic, readings, used: display === 'used', hideLabel: node.selected,
    onWidth: widthChanged, onTasks: () => focusNodeTasks({ id: node.id, label: node.label ?? node.platformLabel ?? node.id,
      agent: node.remoteAgent ?? (node.side === 1 && !node.deviceId ? node.platform ?? node.id : undefined), accountId: node.accountId,
      upstreamSourceId: node.upstreamSourceId, sourceIds: node.side === -1 && !node.upstreamSourceId ? node.sourceIds : undefined, deviceId: node.side === 1 ? node.deviceId : undefined }),
  });
}
export function useDeviceNodes(left: NodeView[], right: NodeView[]) {
  const sourceSnapshot = connector.use().sources;
  const enabled = deviceLinkEnabled.use(), snapshot = deviceSnapshot.use(), deviceSelection = deviceView.use();
  const remote = deviceTasks.use();
  return useMemo(() => {
    const openDevice = (selection: ReturnType<typeof deviceView.get>) => {
      const current = deviceView.get();
      const same = current.detail === selection.detail && current.agent === selection.agent && current.upstreamSource === selection.upstreamSource;
      layers.switchPanel(() => deviceView.set(selection), same);
    };
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
        {single && <span className="device-node-badge"><Icon icon={Laptop} size={10} /></span>}</span>;
      const label = single ? `${device.name} · ${agentName(single)}` : device.name;
      const managingDevice = deviceSelection.detail === device.id && !deviceSelection.agent;
      const children: NodeView[] = single ? [] : inventory.map(agent => ({
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
    return { left: sourceRoots, right: [...right, ...members] };
  }, [sourceSnapshot, enabled, snapshot, deviceSelection, remote, left, right]);
}

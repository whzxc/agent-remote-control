import { Frame, Icon } from 'adg';
import { AgentIcon } from '../components/agent-icon';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { Field, Input } from '../components/field';
import { PanelShell, PanelHeader } from '../components/panel';
import { SettingLine } from '../components/settings-row';
import { Switch } from '../components/switch';
import { TopologyNode } from './topology-node';
import { TopologyGroup } from './topology-group';
import { TopologyScene, type SceneItem, type ScenePath } from './topology-scene';
import { deviceAggregate, remoteRunning, remoteUnread, unconfirmed, quotaReadings, overflow as overflowState, overflowAggregate } from '../fixtures/node-capsule';
import { nodeCapsuleLayout } from './node-capsule';
import { copy, states, branchForms, accountMembers, profileMembers } from '../fixtures/device-topology';

export type DeviceTopologyState = 'lan' | 'tunnel' | 'offline';
export type DeviceBranchForm = 'multiple' | 'merged-collapsed' | 'merged-expanded';

export function DeviceNode({ state = 'lan', merged = false, expanded = false, controller = false, compact = false, idle = false, overflow = false }: {
  state?: DeviceTopologyState; merged?: boolean; expanded?: boolean; controller?: boolean; compact?: boolean; idle?: boolean; overflow?: boolean;
}) {
  const label = controller ? copy.controller : merged ? copy.merged : copy.member;
  const status = states.find(s => s.name === state)!.status;
  return <div aria-label={`${label} · ${status}`}
    class="flex flex-col items-center text-text" style={{ width: 156 }}>
    <TopologyNode label={label} width={156} capsuleCompact={compact} capsuleWing={controller ? "left" : "right"}
      panelExpanded={expanded}
      taskState={idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowAggregate : deviceAggregate}
      graphic={
      <span class="relative flex size-12 items-center justify-center text-text">
        <>{merged ? <AgentIcon brand="codex" readings={quotaReadings} /> : <Icon name={controller ? 'monitor' : 'laptop'} size={32} />}</>
        <span class={`absolute bottom-1 left-1 size-[6px] rounded-full ${state === 'offline' ? 'bg-text-tertiary' : 'bg-success'}`} />
        {merged && <span class="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-full bg-canvas">
          <Icon name="laptop" size={12} />
        </span>}
      </span>
    } />
    {<span class="text-caption leading-5 text-text-secondary">{status}</span>}
  </div>;
}

export function DeviceNodePanel({ state = 'lan' }: { state?: DeviceTopologyState }) {
  const status = states.find(s => s.name === state)!.status;
  const facts = [
    { label: copy.address, value: copy.addressValue },
    { label: copy.tunnel, value: copy.tunnelValue },
  ];
  return <PanelShell width={420} class="p-5 gap-5">
    <PanelHeader title={copy.member} />
    <div class="flex items-center gap-3 text-small">
      <Icon name="laptop" size={24} /><span>{copy.paired} · {status}</span>
    </div>
    <p class={`text-meta ${state === 'offline' ? 'text-warning' : 'text-text-secondary'}`}>
      {state === 'offline' ? `${copy.lastPath} · ${copy.lastSeen} · ${copy.offlineError}` : copy.lastSeenNow}
    </p>
    <dl class="flex flex-col gap-4">
      {facts.map(f => <div class="flex flex-col gap-1">
        <dt class="text-meta text-text-secondary">{f.label}</dt>
        <dd class="break-all font-mono text-small leading-5">{f.value}</dd>
      </div>)}
    </dl>
    <form class="flex flex-col gap-3">
      <Field label={copy.override}><Input value={copy.overrideValue} /></Field>
      <div class="flex justify-end"><Button>{copy.save}</Button></div>
    </form>
    <div class="flex justify-between gap-3">
      <Button icon="arrow-left-right">{copy.transfer}</Button><Button variant="danger" icon="unlink">{copy.unpair}</Button>
    </div>
  </PanelShell>;
}

export function ControllerSourcePanel({ upstreams }: { upstreams: boolean }) {
  return <PanelShell width={420} class="p-5 gap-4">
    <PanelHeader title={copy.controller} />
    <Card class="py-0! gap-0!">
      <SettingLine title={copy.upstreams}><Switch checked={upstreams} label={copy.upstreams} /></SettingLine>
    </Card>
    <div class="flex justify-end"><Button icon="settings">{copy.manage}</Button></div>
  </PanelShell>;
}

export function DeviceAddEndpoint({ open = false }: { open?: boolean }) {
  return <div class="flex items-end gap-3">
    <button aria-label={copy.add} aria-expanded={open} class="mb-2 size-3 rounded-full bg-role-agent" />
    {open && <Card class="p-2! gap-1!">
      <Button icon="bot" variant="ghost">{copy.addAgent}</Button>
      <Button icon="laptop" variant="ghost">{copy.addDevice}</Button>
    </Card>}
  </div>;
}

export function DeviceBranch({ state = 'lan', form = 'multiple', idle = false, panelOpen = false, overflow = false }: {
  state?: DeviceTopologyState; form?: DeviceBranchForm; idle?: boolean; panelOpen?: boolean; overflow?: boolean;
}) {
  const merged = form !== 'multiple', expanded = form !== 'merged-collapsed';
  const deviceState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowAggregate : deviceAggregate;
  const agentState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowState : remoteRunning;
  const otherState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowState : remoteUnread;
  const deviceEdge = 54 + nodeCapsuleLayout(deviceState).width;
  const agentEdge = 314 + nodeCapsuleLayout(agentState).width;
  const otherEdge = 314 + nodeCapsuleLayout(otherState).width;
  const items: SceneItem[] = [{ x: 0, y: 120, content: <DeviceNode state={state} merged={merged} expanded={expanded} idle={idle} overflow={overflow} /> }];
  const paths: ScenePath[] = [];
  const link = (d: string) => paths.push({ d, class: 'stroke-role-agent/55', 'stroke-width': '2' });
  if (!merged && !panelOpen) {
    items.push(
      { x: 283, y: 60, content: <TopologyNode label="Codex" brand="codex" readings={quotaReadings} taskState={agentState} /> },
      { x: 283, y: 290, content: <TopologyNode label="Claude Code" brand="claude-code" readings={quotaReadings} taskState={otherState} /> },
      { x: 543, y: 0, content: <TopologyNode label={copy.profile} brand="codex" /> },
      { x: 574, y: 170, content: <TopologyGroup label={copy.accounts} members={accountMembers} /> },
      { x: 543, y: 290, content: <TopologyNode label={copy.profile} brand="claude-code" /> },
    );
    link(`M${deviceEdge} 146H270Q286 146 286 130V100Q286 86 300 86H314 M286 146V300Q286 316 302 316H314`);
    link(`M${agentEdge} 86H542Q558 86 558 70V42Q558 26 574 26 M558 86V174Q558 190 574 190`);
    link(`M${otherEdge} 316H574`);
  } else if (merged && expanded && !panelOpen) {
    items.push(
      { x: 283, y: 60, content: <TopologyNode label={copy.profile} brand="codex" /> },
      { x: 314, y: 230, content: <TopologyGroup label={copy.accounts} members={accountMembers} /> },
    );
    link(`M${deviceEdge} 146H270Q286 146 286 130V102Q286 86 302 86H314 M286 146V234Q286 250 314 250`);
  }
  return <div class={`inline-flex ${state === 'offline' ? 'opacity-40' : ''}`}>
    <TopologyScene width={merged ? expanded ? 430 : 300 : 690} height={merged ? 300 : 366}
      transparent items={items} paths={paths} />
  </div>;
}

export function PortraitDeviceBranch({ rootX, idle = false, state = 'lan', overflow = false }: { rootX: number; idle?: boolean; state?: DeviceTopologyState; overflow?: boolean }) {
  const deviceState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowAggregate : deviceAggregate;
  const agentState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowState : remoteRunning;
  const otherState = idle ? {} : state === 'offline' ? unconfirmed : overflow ? overflowState : remoteUnread;
  const deviceEdge = rootX + nodeCapsuleLayout(deviceState, true).width;
  const agentX = rootX + 152, accountX = rootX + 304;
  const agentEdge = agentX + nodeCapsuleLayout(agentState, true).width;
  const otherEdge = agentX + nodeCapsuleLayout(otherState, true).width;
  return <div class={state === 'offline' ? 'opacity-40' : ''}><TopologyScene width={rootX + 430} height={800} transparent items={[
    { x: rootX - 54, y: 540, content: <DeviceNode compact expanded idle={idle} state={state} overflow={overflow} /> },
    { x: agentX - 31, y: 490, content: <TopologyNode label="Codex" brand="codex" readings={quotaReadings}
      taskState={agentState} capsuleCompact /> },
    { x: agentX - 31, y: 640, content: <TopologyNode label="Claude Code" brand="claude-code" readings={quotaReadings}
      taskState={otherState} capsuleCompact /> },
    { x: accountX - 31, y: 460, content: <TopologyNode label={copy.profile} brand="codex" /> },
    { x: accountX, y: 560, content: <TopologyGroup label={copy.accounts} members={accountMembers} /> },
    { x: accountX - 31, y: 640, content: <TopologyNode label={copy.profile} brand="claude-code" /> },
  ]} paths={[
    `M${deviceEdge} 566H${rootX + 126}Q${rootX + 136} 566 ${rootX + 136} 556V526Q${rootX + 136} 516 ${agentX} 516`,
    `M${rootX + 136} 566V654Q${rootX + 136} 666 ${agentX} 666`,
    `M${agentEdge} 516H${accountX - 28}Q${accountX - 16} 516 ${accountX - 16} 504V498Q${accountX - 16} 486 ${accountX} 486`,
    `M${accountX - 16} 516V568Q${accountX - 16} 580 ${accountX} 580`,
    `M${otherEdge} 666H${accountX}`,
  ].map(d => ({ d, class: 'stroke-role-agent/55', 'stroke-width': '2' }))} /></div>;
}

export default () => [
  ...branchForms.map(({ name, ...props }) => <Frame name={name}><DeviceBranch {...props} /></Frame>),
  ...states.map(({ name }) => <Frame name={`device-node-panel-${name}`}><DeviceNodePanel state={name} /></Frame>),
  ...[false, true].map(upstreams => <Frame name={`controller-source-panel-${upstreams ? 'on' : 'off'}`}>
    <ControllerSourcePanel upstreams={upstreams} />
  </Frame>),
  <Frame name="device-add-endpoint-open"><DeviceAddEndpoint open /></Frame>,
];

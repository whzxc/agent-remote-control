import { Frame, Icon } from 'adg';
import { BrandMark } from '../components/agent-icon';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { Field, Input } from '../components/field';
import { PanelShell, PanelHeader } from '../components/panel';
import { SettingLine } from '../components/settings-row';
import { Switch } from '../components/switch';
import { TopologyNode } from './topology-node';
import { TopologyGroup } from './topology-group';
import { TopologyScene, type SceneItem, type ScenePath } from './topology-scene';
import { deviceAggregate, remoteRunning, remoteUnread, unconfirmed } from '../fixtures/topology-task-state';
import { copy, states, branchForms, accountMembers, profileMembers } from '../fixtures/device-topology';

export type DeviceTopologyState = 'lan' | 'tunnel' | 'offline';
export type DeviceBranchForm = 'multiple' | 'merged-collapsed' | 'merged-expanded';

export function DeviceNode({ state = 'lan', merged = false, expanded = false, controller = false, hideLabel = false }: {
  state?: DeviceTopologyState; merged?: boolean; expanded?: boolean; controller?: boolean; hideLabel?: boolean;
}) {
  const label = controller ? copy.controller : merged ? copy.merged : copy.member;
  const status = states.find(s => s.name === state)!.status;
  return <div aria-label={`${label} · ${status}`}
    class="flex flex-col items-center text-text" style={{ width: hideLabel ? 48 : 156 }}>
    <TopologyNode label={label} width={156} hideLabel={hideLabel}
      taskState={state === 'offline' ? unconfirmed : deviceAggregate} graphic={
      <button aria-label={`Manage ${label}`} aria-expanded={expanded}
        class="relative flex size-12 items-center justify-center text-text">
        <Icon name={controller ? 'monitor' : 'laptop'} size={32} />
        <span class={`absolute bottom-1 left-1 size-[6px] rounded-full ${state === 'offline' ? 'bg-text-tertiary' : 'bg-success'}`} />
        {merged && <span class="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-full bg-canvas">
          <BrandMark brand="codex" size={16} />
        </span>}
      </button>
    } />
    {!hideLabel && <span class="text-caption leading-5 text-text-secondary">{status}</span>}
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

export function DeviceBranch({ state = 'lan', form = 'multiple' }: { state?: DeviceTopologyState; form?: DeviceBranchForm }) {
  const merged = form !== 'multiple';
  const expanded = form !== 'merged-collapsed';
  const items: SceneItem[] = [
    { x: 0, y: expanded ? 90 : 8, content: <DeviceNode state={state} merged={merged} expanded={expanded} /> },
  ];
  const paths: ScenePath[] = [];
  const link = (d: string) => paths.push({ d, class: 'stroke-role-agent/55', 'stroke-width': '2' });
  if (!merged) {
    items.push(
      { x: 180, y: 40, content: <TopologyNode label="Codex" brand="codex"
        taskState={state === 'offline' ? unconfirmed : remoteRunning} /> },
      { x: 180, y: 220, content: <TopologyNode label="Claude Code" brand="claude-code"
        taskState={state === 'offline' ? unconfirmed : remoteUnread} /> },
      { x: 288, y: 0, content: <TopologyNode label={copy.profile} brand="codex" /> },
      { x: 312, y: 120, content: <TopologyGroup label={copy.accounts} members={accountMembers} /> },
      { x: 288, y: 220, content: <TopologyNode label={copy.profile} brand="claude-code" /> },
    );
    link('M102 114H140Q152 114 152 102V76Q152 64 164 64H211 M152 114V232Q152 244 164 244H211');
    link('M259 64H274Q286 64 286 52V36Q286 24 298 24H319 M286 64V128Q286 140 298 140H312');
    link('M259 244H319');
  } else if (expanded) {
    items.push(
      { x: 180, y: 40, content: <TopologyNode label={copy.profile} brand="codex" /> },
      { x: 204, y: 180, content: <TopologyGroup label={copy.accounts} members={accountMembers} /> },
    );
    link('M102 114H140Q152 114 152 102V76Q152 64 164 64H211 M152 114V188Q152 200 164 200H204');
  }
  return <div class={`inline-flex ${state === 'offline' ? 'opacity-40' : ''}`}>
    <TopologyScene width={!expanded ? 156 : merged ? 300 : 422} height={!expanded ? 104 : merged ? 244 : 296}
      transparent items={items} paths={paths} />
  </div>;
}

export function PortraitDeviceBranch({ narrow = false }: { narrow?: boolean }) {
  const device = narrow ? { x: 326, y: 100 } : { x: 568, y: 70 };
  const agentX = narrow ? 254 : 480;
  const agentY = narrow ? [0, 240] : [10, 230];
  const groupX = narrow ? 154 : 386;
  const links = narrow
    ? ['M326 124H314V24H302 M314 124V264H302', 'M254 24H243 M254 264H218']
    : ['M568 94H552V34H528 M552 94V254H528', 'M480 34H448 M480 254H448'];
  return <TopologyScene width={narrow ? 390 : 640} height={310} transparent
    items={[
      { ...device, content: <DeviceNode hideLabel expanded /> },
      ...agentY.map((y, i) => ({ x: agentX, y, content: <TopologyNode hideLabel
        label={i ? 'Claude Code' : 'Codex'} brand={i ? 'claude-code' : 'codex'}
        taskState={i ? remoteUnread : remoteRunning} /> })),
      ...agentY.map((y, i) => ({ x: groupX, y: y + 4, content: <TopologyGroup hideLabel
        label={i ? copy.profiles : copy.accounts} members={i ? profileMembers : accountMembers} /> })),
    ]} paths={links.map(d => ({ d, class: 'stroke-role-agent/55', 'stroke-width': '2' }))} />;
}

export default () => [
  ...branchForms.map(({ name, ...props }) => <Frame name={name}><DeviceBranch {...props} /></Frame>),
  ...states.map(({ name }) => <Frame name={`device-node-panel-${name}`}><DeviceNodePanel state={name} /></Frame>),
  ...[false, true].map(upstreams => <Frame name={`controller-source-panel-${upstreams ? 'on' : 'off'}`}>
    <ControllerSourcePanel upstreams={upstreams} />
  </Frame>),
  <Frame name="device-add-endpoint-open"><DeviceAddEndpoint open /></Frame>,
];

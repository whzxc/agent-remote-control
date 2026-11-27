import { copy, samples, agentCards, uninstalledAgents, nativeCopy, type AgentCardSample } from '../fixtures/agent-settings';
import { SettingsChoices as Choices, SettingsGroup as Group, SettingLine } from "../components/settings-row";
import { Frame, Icon } from "adg";
import { Panel, Dialog } from "../components/panel";
import { Card } from "../components/card";
import { Switch } from "../components/switch";
import { IconButton } from "../components/icon-button";
import { BrandMark } from "../components/brand-mark";

const toneDot = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-text-tertiary',
} as const;

export function AgentInventoryCard({ agent = agentCards[0] }: { agent?: AgentCardSample }) {
  return (
    <Card className="gap-[10px]! p-[14px]!">
      <div className="flex items-center gap-3">
        <BrandMark brand={agent.brand} size={28} />
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <strong className="truncate text-body leading-5 font-[650] text-text">{agent.name}</strong>
          <span className="truncate text-caption leading-4 text-text-secondary">{agent.meta}</span>
        </div>
        <Switch checked={agent.enabled} label={agent.name} />
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-[8px] text-caption leading-4 text-text-secondary">
        {agent.quotaLabel && (
          <span className="inline-flex min-w-0 items-center gap-[5px] truncate">
            <span className={`size-[6px] shrink-0 rounded-full ${toneDot[agent.quotaTone ?? 'muted']}`} aria-hidden="true" />
            <span className="truncate tabular-nums">{agent.quotaLabel}</span>
          </span>
        )}
        {agent.spec && (
          <span className="ml-auto shrink-0 rounded-full bg-surface px-2 py-[1px] text-caption text-text-secondary">
            {agent.spec}
          </span>
        )}
        <Icon name="chevron-right" size={14} className={`shrink-0 text-text-tertiary ${agent.spec ? '' : 'ml-auto'}`} />
      </div>
    </Card>
  );
}

export function AgentDispatchSettings() {
  return (<Group title={copy.text4}>
          <SettingLine title={copy.text5} className="py-[6px]! min-h-[54px]!">
            <Choices
              label={copy.text6}
              options={samples.sample7}
              width={360}
              dropdown
            />
          </SettingLine>
        </Group>);
}

export function AgentDetail() {
  return (
    <Dialog headerless>
      <header className="flex h-[46px] items-start justify-between gap-4">
        <div className="flex items-start gap-3 pt-[3px]">
          <BrandMark brand="codex" size={40} />
          <div className="flex flex-col gap-1 pt-[2px]">
            <h2 className="text-title leading-6 font-[650]">{copy.text8}</h2>
            <div className="flex gap-4 text-meta leading-4 font-normal">
              <span className="text-text-secondary">{copy.text9}</span>
              <span className="text-small text-accent-text">{copy.text10}</span>
            </div>
          </div>
        </div>
        <IconButton icon="x" label={copy.text11} />
      </header>
      <div className="pt-4">
        <AgentDispatchSettings  />
      </div>
    </Dialog>
  );
}

export function Agents({ workspace = false }: { workspace?: boolean } = {}) {
  return (
    <Panel viewportHeight={workspace ? 800 : undefined}
      title={copy.text12}
      actions={<IconButton icon="refresh-cw" label={copy.text13} />}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex h-[33px] items-center gap-[6px]">
            <h3 className="mr-[13px] text-small font-[650] text-text-secondary">{copy.text14}</h3>
            <IconButton icon="gauge" label={copy.text15} />
            <IconButton icon="settings" label={copy.text16} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {agentCards.map(agent => <AgentInventoryCard agent={agent} />)}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-small font-[650] text-text-secondary">{copy.notInstalled}</h3>
          <div className="grid grid-cols-4 gap-2">
            {uninstalledAgents.map(agent => (
              <div className="flex items-center gap-2 rounded-tile bg-surface-subtle px-3 py-2 text-small text-text-secondary">
                <BrandMark brand={agent.brand} size={20} />
                <span className="truncate">{agent.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function NativeAgentInfo({ className: extra = 'mt-7' }: {className?:string}) {return (
<div className={`flex items-start gap-2 rounded-card bg-surface-subtle px-4 py-[14px] ${extra}`}>
          <p className="flex-1 text-small leading-5 text-text-secondary">{nativeCopy.text1}<br />{nativeCopy.text2}</p>
          <div className="-mt-[7px] flex gap-1">
            <IconButton compact icon="refresh-cw" label={nativeCopy.text3} />
            <IconButton compact icon="settings" label={nativeCopy.text4} />
          </div>
        </div>);}

export default () => [
  <Frame name="agent-inventory-card" width={296}>
    <div className="w-full bg-surface-raised"><AgentInventoryCard /></div>
  </Frame>,
  <Frame name="agent-dispatch-settings" width={672}>
    <div className="w-full bg-surface-raised"><AgentDispatchSettings  /></div>
  </Frame>,
  <Frame name="native-agent-info" width={440}>
    <div className="w-full bg-surface-raised"><NativeAgentInfo className="" /></div>
  </Frame>,
];

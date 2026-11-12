import { copy, samples } from '../fixtures/agent-settings';

import { SettingsChoices as Choices, SettingsGroup as Group } from "../components/settings-row";
import { Frame } from "adg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { SettingLine } from "../components/settings-row";
import { Switch } from "../components/switch";
import { IconButton } from "../components/icon-button";
import { BrandMark } from "../components/agent-icon";


export function AgentInventoryCard() {
  return (<Card padded>
          <div class="flex items-center gap-4 py-2">
            <BrandMark brand="codex" size={40} />
            <div class="flex flex-col gap-[6px]">
              <strong class="text-body leading-4 font-[650]">{copy.text1}</strong>
              <span class="text-meta leading-4 text-text-secondary">{copy.text2}</span>
            </div>
            <div class="ml-auto">
              <Switch checked label={copy.text3} />
            </div>
          </div>
        </Card>);
}

export function AgentDispatchSettings() {
  return (<Group title={copy.text4}>
          <SettingLine title={copy.text5} class="py-[6px]! min-h-[54px]!">
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
    <Panel width={720} headerless>
      <header class="flex h-[46px] items-start justify-between gap-4">
        <div class="flex items-start gap-3 pt-[3px]">
          <BrandMark brand="codex" size={40} />
          <div class="flex flex-col gap-1 pt-[2px]">
            <h2 class="text-title leading-6 font-[650]">{copy.text8}</h2>
            <div class="flex gap-4 text-meta leading-4 font-normal">
              <span class="text-text-secondary">{copy.text9}</span>
              <span class="text-small text-accent-text">{copy.text10}</span>
            </div>
          </div>
        </div>
        <IconButton icon="x" label={copy.text11} />
      </header>
      <div class="pt-4">
        <AgentDispatchSettings  />
      </div>
    </Panel>
  );
}
export function Agents({ workspace = false }: { workspace?: boolean } = {}) {
  return (
    <Panel
      size="l" viewportHeight={workspace ? 800 : undefined}
      title={copy.text12}
      actions={<IconButton icon="refresh-cw" label={copy.text13} />}
    >
      <div class="flex flex-col gap-[11px]">
        <div class="flex h-[33px] items-center gap-[6px]">
          <h3 class="mr-[13px] text-small font-[650] text-text-secondary">{copy.text14}</h3>
          <IconButton icon="gauge" label={copy.text15} />
          <IconButton icon="settings" label={copy.text16} />
        </div>
        <AgentInventoryCard  />
      </div>
    </Panel>
  );
}
import { nativeCopy } from '../fixtures/agent-settings';

export function NativeAgentInfo({ class: extra = 'mt-7' }: {class?:string}) {return (
<div class={`flex items-start gap-2 rounded-card bg-surface-subtle px-4 py-[14px] ${extra}`}>
          <p class="flex-1 text-small leading-5 text-text-secondary">{nativeCopy.text1}<br />{nativeCopy.text2}</p>
          <div class="-mt-[7px] flex gap-1">
            <IconButton compact icon="refresh-cw" label={nativeCopy.text3} />
            <IconButton compact icon="settings" label={nativeCopy.text4} />
          </div>
        </div>);}

export default () => [
  <Frame name="agent-inventory-card" width={672}>
    <div class="w-full bg-surface-raised"><AgentInventoryCard  /></div>
  </Frame>,
  <Frame name="agent-dispatch-settings" width={672}>
    <div class="w-full bg-surface-raised"><AgentDispatchSettings  /></div>
  </Frame>,
  <Frame name="native-agent-info" width={440}>
    <div class="w-full bg-surface-raised"><NativeAgentInfo class="" /></div>
  </Frame>,
];

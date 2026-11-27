import { Frame } from "adg";
import { AgentDetailView } from "@/components/settings/AgentDetailView";
import {
  AgentInventoryCardView,
  AgentSettingsGridView,
} from "@/components/settings/AgentSettingsGridView";
import { LocaleProvider } from "@/i18n/react";
import { BrandMark } from "../components/brand-mark";
import { IconButton } from "../components/icon-button";
import { Dialog, Panel } from "../components/panel";
import {
  SettingLine,
  SettingsChoices as Choices,
  SettingsGroup as Group,
} from "../components/settings-row";
import {
  agentCards,
  copy,
  nativeCopy,
  samples,
  uninstalledAgents,
  type AgentCardSample,
} from "../fixtures/agent-settings";

function toCardItem(agent: AgentCardSample) {
  return {
    id: agent.brand,
    title: agent.name,
    icon: <BrandMark brand={agent.brand} size={28} />,
    metaText: agent.meta,
    enabled: agent.enabled,
    quotaText: agent.quotaLabel,
    quotaTone: agent.quotaTone,
    statusText: agent.spec ?? (agent.enabled ? "Ready" : "Disabled"),
  };
}

export function AgentInventoryCard({
  agent = agentCards[0],
}: {
  agent?: AgentCardSample;
}) {
  return (
    <LocaleProvider locale="en">
      <AgentInventoryCardView agent={toCardItem(agent)} />
    </LocaleProvider>
  );
}

export function AgentDispatchSettings() {
  return (
    <Group title={copy.text4}>
      <SettingLine title={copy.text5} className="min-h-[54px]! py-[6px]!">
        <Choices
          label={copy.text6}
          options={samples.sample7}
          width={360}
          dropdown
        />
      </SettingLine>
    </Group>
  );
}

export function AgentDetail() {
  return (
    <Dialog headerless>
      <div className="relative">
        <div className="absolute top-0 right-0">
          <IconButton compact icon="x" label={copy.text11} />
        </div>
        <LocaleProvider locale="en">
          <AgentDetailView
            title={copy.text8}
            icon={<BrandMark brand="codex" size={36} />}
            versionText={copy.text9}
            officialLink="https://github.com/openai/codex"
            dispatchDefaultsSlot={<AgentDispatchSettings />}
          />
        </LocaleProvider>
      </div>
    </Dialog>
  );
}

export function Agents({ workspace = false }: { workspace?: boolean } = {}) {
  return (
    <Panel
      viewportHeight={workspace ? 800 : undefined}
      title={copy.text12}
      actions={<IconButton icon="refresh-cw" label={copy.text13} />}
    >
      <LocaleProvider locale="en">
        <AgentSettingsGridView
          installed={agentCards.map(toCardItem)}
          uninstalled={uninstalledAgents.map((agent) => ({
            id: agent.brand,
            title: agent.name,
            icon: <BrandMark brand={agent.brand} size={20} />,
          }))}
        />
      </LocaleProvider>
    </Panel>
  );
}

export function NativeAgentInfo({
  className: extra = "mt-7",
}: {
  className?: string;
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-kit-card border border-border bg-surface-subtle px-4 py-3.5 ${extra}`}
    >
      <p className="flex-1 text-small leading-5 text-text-secondary">
        {nativeCopy.text1}
        <br />
        {nativeCopy.text2}
      </p>
      <div className="-mt-1 flex gap-1">
        <IconButton compact icon="refresh-cw" label={nativeCopy.text3} />
        <IconButton compact icon="settings" label={nativeCopy.text4} />
      </div>
    </div>
  );
}

export default () => [
  <Frame key="agent-inventory-card" name="agent-inventory-card" width={296}>
    <div className="w-full bg-surface-raised">
      <AgentInventoryCard />
    </div>
  </Frame>,
  <Frame
    key="agent-dispatch-settings"
    name="agent-dispatch-settings"
    width={672}
  >
    <div className="w-full bg-surface-raised">
      <AgentDispatchSettings />
    </div>
  </Frame>,
  <Frame key="native-agent-info" name="native-agent-info" width={440}>
    <div className="w-full bg-surface-raised">
      <NativeAgentInfo className="" />
    </div>
  </Frame>,
];

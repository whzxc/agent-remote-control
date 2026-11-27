import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { readOnlyBrowser } from "../browserMode";
import { t } from "../i18n";
import { openUrl } from "../platform";
import { refreshAccountQuota, useAccounts } from "../state/accounts";
import { agentActivity } from "../state/activity";
import {
  agentLinks,
  agents,
  compactAgentVersion,
  icons,
  name,
  orderedAgents,
  refreshAgents,
  toggleAgent,
  type Agent,
} from "../state/agents";
import { useAppNow } from "../state/appEnvironment";
import { resolveAgentQuota } from "../state/quota";
import { subscriptions } from "../state/subscriptions";
import { iconWindows } from "../subscriptions/AgentQuotaIcon";
import {
  quotaDisplay,
  quotaLabel,
  quotaPercent,
} from "../subscriptions/displayPreferences";
import { windowLabel } from "../subscriptions/labels";
import {
  errorLabels,
  isSoftProviderError,
  readingStatus,
} from "../subscriptions/presentation";
import QuotaBubble from "../subscriptions/QuotaBubble";
import type { ProviderSnapshot } from "../subscriptions/types";
import UsageOverview from "../subscriptions/UsageOverview";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import AgentDisplaySettings from "./AgentDisplaySettings";
import { IconButton } from "./kit/button";
import { AgentDetailView } from "./settings/AgentDetailView";
import {
  AgentInventoryCardView,
  AgentSettingsGridView,
  type AgentCardItem,
} from "./settings/AgentSettingsGridView";
import Panel from "./ui/Panel";
import { SettingsDialog as Dialog } from "./ui/Settings";

const adapterErrorKeys: Record<string, string> = {
  CLAUDE_ADAPTER_DOWNLOAD_FAILED: "agentAdapterDownloadFailed",
  CLAUDE_ADAPTER_CHECKSUM_FAILED: "agentAdapterChecksumFailed",
  CLAUDE_ADAPTER_EXTRACT_FAILED: "agentAdapterExtractFailed",
  CLAUDE_ADAPTER_PROBE_FAILED: "agentAdapterProbeFailed",
};

const discoveryMessage = (agent: Agent) => {
  if (!agent.discoveryError) return "";
  if (agent.discoveryError === "AGENT_NOT_INSTALLED") {
    return t("agentNotInstalled");
  }
  return t(
    agent.agent === "antigravity"
      ? "agentDiscoveryAntigravity"
      : "agentDiscoveryFailed",
  );
};

const readiness = (agent: Agent) => {
  if (!agent.installed) return t("agentNotInstalled");
  if (!agent.available) return t("agentUnavailable");
  return t(agent.enabled ? "agentReady" : "agentDisabled");
};

function toAgentCardItem(
  agent: Agent,
  provider: ProviderSnapshot | undefined,
  activeCount: number,
  busy: boolean,
  now: number,
): AgentCardItem {
  const title = name(agent);
  const window = provider && iconWindows(provider, now, true)[0];
  const quotaError = provider?.error;
  const hardQuotaError = !!quotaError && !isSoftProviderError(quotaError.code);
  const quotaText = provider
    ? quotaError
      ? t(errorLabels[quotaError.code] ?? "usageUnavailable")
      : window
        ? `${windowLabel(window.label)} · ${quotaLabel()} ${quotaPercent(window)}`
        : t("usageUnavailable")
    : undefined;
  const rank = provider && readingStatus(window, provider, now).rank;
  const quotaTone =
    rank === 4
      ? "danger"
      : rank === 3 || rank === 2
        ? "warning"
        : rank === 1
          ? "success"
          : "muted";
  const adapter = agent.adapter;
  const adapterMessage =
    adapter && adapter.state !== "ready"
      ? `${t(
          adapter.state === "preparing"
            ? "agentAdapterPreparing"
            : adapter.state === "failed"
              ? "agentAdapterFailed"
              : "agentAdapterMissing",
        )}${
          adapter.error
            ? ` · ${t(adapterErrorKeys[adapter.error] || "agentAdapterSetupFailed")}`
            : ""
        }`
      : undefined;

  return {
    id: agent.agent,
    title,
    link: agentLinks[agent.agent],
    iconMarkup: icons[agent.agent],
    version: agent.version || undefined,
    metaText: [compactAgentVersion(agent.version), readiness(agent)]
      .filter(Boolean)
      .join(" · "),
    enabled: agent.enabled === true,
    switchDisabled:
      readOnlyBrowser ||
      busy ||
      adapter?.state === "preparing" ||
      typeof agent.enabled !== "boolean",
    quotaText,
    quotaTooltip: quotaError?.message || quotaText,
    quotaTone,
    hardQuotaError,
    statusText: activeCount
      ? t("agentPanel.inProgress", { count: activeCount })
      : readiness(agent),
    adapterMessage,
    adapterFailed: adapter?.state === "failed",
  };
}

function AgentCard({ agent, provider, activeCount, busy, now, onOpen, onError }: {
  agent: Agent; provider?: ProviderSnapshot; activeCount: number; busy: boolean; now: number;
  onOpen: () => void; onError: (error: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const open = () => {
    trigger.current?.focus({ preventScroll: true });
    onOpen();
  };
  return (
    <AgentInventoryCardView
      agent={toAgentCardItem(agent, provider, activeCount, busy, now)}
      triggerRef={trigger}
      onOpen={open}
      onOpenLink={(href) => void openUrl(href).catch((error) => onError(String(error)))}
      onToggle={(enabled) => void toggleAgent(agent, enabled)}
    />
  );
}

export function AgentDetails({
  agent: selected,
  onClose,
  showOfficialLink = false,
}: {
  agent: Agent;
  showOfficialLink?: boolean;
  onClose: () => void;
}) {
  const inventory = agents.use();
  const agent =
    inventory.items.find((item) => item.agent === selected.agent) || selected;
  const { snapshot } = subscriptions.use();
  const [savingDefaults, setSavingDefaults] = useState(false);
  const { items: accounts } = useAccounts();
  const provider = resolveAgentQuota(agent.agent, snapshot, accounts);
  const quotaAccountId = provider?.quotaAccountId;
  const link = showOfficialLink ? agentLinks[agent.agent] : undefined;

  return (
    <Dialog busy={savingDefaults} title={name(agent)} onClose={onClose} headerless>
      <AgentDetailView
        title={name(agent)}
        iconMarkup={icons[agent.agent]}
        version={agent.version || undefined}
        versionText={
          agent.installed !== undefined
            ? agent.installed
              ? compactAgentVersion(agent.version)
              : t("agentNotInstalled")
            : undefined
        }
        officialLink={link}
        discoveryMessage={
          agent.discoveryError && agent.discoveryError !== "AGENT_NOT_INSTALLED"
            ? discoveryMessage(agent)
            : undefined
        }
        discoveryError={
          agent.discoveryError && agent.discoveryError !== "AGENT_NOT_INSTALLED"
            ? agent.discoveryError
            : undefined
        }
        quotaSlot={
          provider && (
            <QuotaBubble
              provider={provider}
              onRefresh={
                quotaAccountId
                  ? () => refreshAccountQuota(quotaAccountId)
                  : undefined
              }
            />
          )
        }
        dispatchDefaultsSlot={
          agent.installed && (
            <AgentDispatchDefaults
              agent={agent.agent}
              onBusy={setSavingDefaults}
            />
          )
        }
        onOpenOfficialLink={link ? () => void openUrl(link) : undefined}
      />
    </Dialog>
  );
}

export default function AgentsSettings({
  onClose,
  initialAgent,
}: {
  onClose: () => void;
  initialAgent?: Agent;
}) {
  const state = agents.use();
  const items = orderedAgents();
  const [detail, setDetail] = useState<Agent | undefined>(initialAgent);
  const [display, setDisplay] = useState(false);
  const [overview, setOverview] = useState(false);
  const [error, setError] = useState("");
  const { snapshot } = subscriptions.use();
  const { items: accounts } = useAccounts();
  const activity = agentActivity.use().snapshot;
  const now = useAppNow(60000);
  quotaDisplay.use();

  const installed = items.filter((agent) => agent.installed);
  const uninstalled = items.filter((agent) => !agent.installed);
  const busy = state.loading || !!state.saving;

  return (
    <>
      <Panel
        className="settings-dialog"
        title={t("agents")}
        busy={busy}
        onClose={onClose}
        actions={
          <IconButton
            compact
            icon={RefreshCw}
            label={t("refreshAgents")}
            busy={state.loading}
            disabled={!!state.saving}
            onClick={() => void refreshAgents(true)}
          />
        }
      >
        <AgentSettingsGridView
          installed={installed.map((agent) =>
            toAgentCardItem(
              agent,
              resolveAgentQuota(agent.agent, snapshot, accounts),
              activity?.agents[agent.agent]?.sessions.length ?? 0,
              busy,
              now,
            ),
          )}
          uninstalled={uninstalled.map((agent) => ({
            id: agent.agent,
            title: name(agent),
            link: agentLinks[agent.agent],
            iconMarkup: icons[agent.agent],
          }))}
          loaded={state.loaded}
          loading={state.loading}
          loadError={state.error || undefined}
          actionError={error || undefined}
          onOpenOverview={() => setOverview(true)}
          onOpenDisplaySettings={() => setDisplay(true)}
          onOpenLink={(href) =>
            void openUrl(href).catch((failure) => setError(String(failure)))
          }
          renderInstalledCard={(card) => {
            const agent = installed.find((entry) => entry.agent === card.id)!;
            return (
              <AgentCard
                key={agent.agent}
                agent={agent}
                provider={resolveAgentQuota(agent.agent, snapshot, accounts)}
                activeCount={activity?.agents[agent.agent]?.sessions.length ?? 0}
                busy={busy}
                now={now}
                onOpen={() => setDetail(agent)}
                onError={setError}
              />
            );
          }}
        />
      </Panel>
      {detail && (
        <AgentDetails
          showOfficialLink
          agent={detail}
          onClose={() => setDetail(undefined)}
        />
      )}
      {overview && (
        <UsageOverview
          onClose={() => setOverview(false)}
          onNavigate={() => {
            setOverview(false);
            setDisplay(true);
          }}
        />
      )}
      {display && <AgentDisplaySettings onClose={() => setDisplay(false)} />}
    </>
  );
}

import { Tooltip as HoverHelp } from "./ui/index";
import Panel from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import { useRef, useState } from "react";
import { ChevronRight, CircleAlert, RefreshCw, Settings, Gauge } from "lucide-react";
import { t } from "../i18n";
import { openUrl } from "../platform";
import { agents, orderedAgents, name, icons, compactAgentVersion, agentLinks, toggleAgent, refreshAgents, type Agent } from "../state/agents";
import { refreshAccountQuota, useAccounts } from "../state/accounts";
import { agentActivity } from "../state/activity";
import { captureLayerTrigger } from "../state/layers";
import { resolveAgentQuota } from "../state/quota";
import { iconWindows } from "../subscriptions/AgentQuotaIcon";
import { quotaDisplay, quotaLabel, quotaPercent } from "../subscriptions/displayPreferences";
import { windowLabel } from "../subscriptions/labels";
import { errorLabels, readingStatus } from "../subscriptions/presentation";
import type { ProviderSnapshot } from "../subscriptions/types";
import { useAppNow } from "../state/appEnvironment";
import { subscriptions } from "../state/subscriptions";
import UsageOverview from "../subscriptions/UsageOverview";
import QuotaBubble from "../subscriptions/QuotaBubble";
import AgentDisplaySettings from "./AgentDisplaySettings";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import { BrandMark, Icon, IconButton, Switch, Notice, Loading } from "./ui";

import { SettingsDialog as Dialog } from "./ui/Settings";
import { Card } from "./ui/card";

const discoveryMessage = (agent: Agent) => {
  if (!agent.discoveryError) return "";
  if (agent.discoveryError === "AGENT_NOT_INSTALLED") return t("agentNotInstalled");
  return t(agent.agent === "antigravity" ? "agentDiscoveryAntigravity" : "agentDiscoveryFailed");
};

const readiness = (agent: Agent) => {
  if (!agent.installed) return t("agentNotInstalled");
  if (!agent.available) return t("agentUnavailable");
  return t(agent.enabled ? "agentReady" : "agentDisabled");
};

function AgentCard({ agent, provider, activeCount, busy, now, onOpen, onError }: {
  agent: Agent; provider?: ProviderSnapshot; activeCount: number; busy: boolean; now: number;
  onOpen: () => void; onError: (error: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const link = agentLinks[agent.agent];
  const title = name(agent);
  const window = provider && iconWindows(provider, now, true)[0];
  const quotaError = provider?.error;
  const quotaText = quotaError ? t(errorLabels[quotaError.code] ?? "usageUnavailable")
    : window ? `${windowLabel(window.label)} · ${quotaLabel()} ${quotaPercent(window)}` : t("usageUnavailable");
  const rank = provider && readingStatus(window, provider, now).rank;
  const tone = rank === 4 ? "danger" : rank === 3 || rank === 2 ? "warning" : rank === 1 ? "success" : "muted";
  const adapter = agent.adapter;
  const open = () => { captureLayerTrigger(trigger.current); onOpen(); };

  return <Card asChild><article className="agent-card" onClick={event => {
    if (!(event.target as Element).closest("button, a")) open();
  }}>
    <div className="agent-card-heading">
      <button ref={trigger} type="button" className="agent-detail-trigger" aria-label={title} aria-haspopup="dialog" onClick={open}>
        <BrandMark markup={icons[agent.agent]} size={28} />
      </button>
      <div className="agent-copy">
        {link ? <a href={link} onClick={event => {
          event.preventDefault();
          void openUrl(link).catch(error => onError(String(error)));
        }}>{title}</a> : <strong>{title}</strong>}
        <HoverHelp text={agent.version || undefined}><span>
          {[compactAgentVersion(agent.version), readiness(agent)].filter(Boolean).join(" · ")}
        </span></HoverHelp>
      </div>
      <span onClick={event => event.stopPropagation()}>
        <Switch label={t("allowConnectorToUseValue", { agent: title })} checked={agent.enabled === true}
          disabled={readOnlyBrowser || busy || adapter?.state === "preparing" || typeof agent.enabled !== "boolean"}
          onChange={enabled => void toggleAgent(agent, enabled)} />
      </span>
    </div>
    <div className="agent-card-telemetry">
      {provider && <span className="agent-card-quota" title={quotaError?.message || quotaText}>
        {quotaError ? <Icon icon={CircleAlert} size={12} /> : <span className="agent-card-quota-dot" data-tone={tone} aria-hidden="true" />}
        <span>{quotaText}</span>
      </span>}
      <span className="agent-card-status">{activeCount ? t("agentPanel.inProgress", { count: activeCount }) : readiness(agent)}</span>
      <Icon icon={ChevronRight} size={14} />
    </div>
    {adapter && adapter.state !== "ready" && (
      <p className="agent-adapter" role={adapter.state === "failed" ? "alert" : "status"}>
        {t(adapter.state === "preparing" ? "agentAdapterPreparing"
          : adapter.state === "failed" ? "agentAdapterFailed" : "agentAdapterMissing")}
        {adapter.error && ` · ${t({ CLAUDE_ADAPTER_DOWNLOAD_FAILED: "agentAdapterDownloadFailed", CLAUDE_ADAPTER_CHECKSUM_FAILED: "agentAdapterChecksumFailed", CLAUDE_ADAPTER_EXTRACT_FAILED: "agentAdapterExtractFailed", CLAUDE_ADAPTER_PROBE_FAILED: "agentAdapterProbeFailed" }[adapter.error] || "agentAdapterSetupFailed")}`}
      </p>
    )}
  </article></Card>;
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
  const agent = inventory.items.find((item) => item.agent === selected.agent) || selected;
  const { snapshot } = subscriptions.use();
  const [savingDefaults, setSavingDefaults] = useState(false);
  const { items: accounts } = useAccounts();
  const provider = resolveAgentQuota(agent.agent, snapshot, accounts);
  const quotaAccountId = provider?.quotaAccountId;
  return (
    <Dialog busy={savingDefaults} title={name(agent)} onClose={onClose} headerless>
      <div className="agent-summary">
        <BrandMark markup={icons[agent.agent]} />
        <div>
          <strong>{name(agent)}</strong>
          <div className="agent-summary-meta">{agent.installed !== undefined && <HoverHelp text={agent.version || undefined}><p>{agent.installed ? compactAgentVersion(agent.version) : t("agentNotInstalled")}</p></HoverHelp>}
          {showOfficialLink && agentLinks[agent.agent] && <a href={agentLinks[agent.agent]} onClick={e => { e.preventDefault(); void openUrl(agentLinks[agent.agent]!); }}>{t("officialSetup")}</a>}</div>
        </div>
      </div>
      {agent.discoveryError && agent.discoveryError !== "AGENT_NOT_INSTALLED" &&
        <Notice>{<>{discoveryMessage(agent)}<br /><small>{agent.discoveryError}</small></>}</Notice>}
      {provider && <QuotaBubble provider={provider} onRefresh={quotaAccountId ? () => refreshAccountQuota(quotaAccountId) : undefined} />}
      {agent.installed && <AgentDispatchDefaults agent={agent.agent} onBusy={setSavingDefaults} />}
    </Dialog>
  );
}
export default function AgentsSettings({ onClose, initialAgent }: { onClose: () => void; initialAgent?: Agent }) {
  const state = agents.use(),
    items = orderedAgents();
  const [detail, setDetail] = useState<Agent | undefined>(initialAgent),
    [display, setDisplay] = useState(false),
    [overview, setOverview] = useState(false),
    [error, setError] = useState("");
  const { snapshot } = subscriptions.use();
  const { items: accounts } = useAccounts();
  const activity = agentActivity.use().snapshot;
  const now = useAppNow(60000);
  quotaDisplay.use();
  const installed = items.filter(agent => agent.installed);
  const uninstalled = items.filter(agent => !agent.installed);
  return (
    <>
      <Panel className="settings-dialog"
        title={t("agents")} busy={state.loading || !!state.saving}
        onClose={onClose}
        actions={
          <>
            <IconButton
              icon={RefreshCw}
              label={t("refreshAgents")}
              busy={state.loading}
              disabled={!!state.saving}
              onClick={() => void refreshAgents(true)}
            />
          </>
        }
      >
        <div className="agents-toolbar">
          <h3>{t("installedAgents")}</h3>
            <IconButton icon={Gauge} label={t("trayUsage")} onClick={() => setOverview(true)} />
            <IconButton
              icon={Settings}
              label={t("agentDisplaySettings")}
              onClick={() => setDisplay(true)}
            />
        </div>
        {!state.loaded && state.loading && <Loading />}
        {!state.loaded && !state.loading && !state.error && <Notice>{t("agentsNotLoaded")}</Notice>}
        {!!state.error && <Notice>{<>{t("agentsRequestFailed")}<br /><small>{state.error}</small></>}</Notice>}
        {state.loaded && !state.error && items.length === 0 && <Notice>{t("agentsEmpty")}</Notice>}
        {installed.length > 0 && <div className="agent-grid">
          {installed.map(agent => {
            const activeCount = activity?.agents[agent.agent]?.sessions.length ?? 0;
            return <AgentCard key={agent.agent} agent={agent} provider={resolveAgentQuota(agent.agent, snapshot, accounts)}
              activeCount={activeCount} busy={state.loading || !!state.saving} now={now}
              onOpen={() => setDetail(agent)} onError={setError} />;
          })}
        </div>}
        {uninstalled.length > 0 && <>
        <h3 className="agent-section-title">{t("notInstalledAgents")}</h3>
        <div className="uninstalled-agents">
          {uninstalled.map(agent => (
            <a
              key={agent.agent}
              className="agent-uninstalled"
              href={agentLinks[agent.agent]}
              onClick={(event) => {
                event.preventDefault();
                void openUrl(agentLinks[agent.agent]!).catch(error => setError(String(error)));
              }}
            >
              <BrandMark markup={icons[agent.agent]} size={20} />
              <span>{name(agent)}</span>
            </a>
          ))}
        </div>
        </>}
        {error && <Notice>{error}</Notice>}
      </Panel>
      {detail && (
        <AgentDetails showOfficialLink agent={detail} onClose={() => setDetail(undefined)} />
      )}
      {overview && <UsageOverview onClose={() => setOverview(false)} onNavigate={() => { setOverview(false); setDisplay(true); }} />}
      {display && <AgentDisplaySettings onClose={() => setDisplay(false)} />}
    </>
  );
}

import { motionTransition } from "../motion/tokens";
import { Tooltip as HoverHelp } from "./ui/index";
import Panel from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import { useReducedMotion } from "../state/appEnvironment";
import { useState, type ReactNode } from "react";
import { motion, Reorder, useDragControls } from "motion/react";
import { RefreshCw, Settings, Gauge } from "lucide-react";
import { t } from "../i18n";
import { openUrl } from "../platform";
import {
  agents,
  orderedAgents,
  moveAgent,
  reorderAgents,
  name,
  icons,
  compactAgentVersion,
  agentLinks,
  toggleAgent,
  refreshAgents,
  type Agent,
} from "../state/agents";
import { subscriptions } from "../state/subscriptions";
import UsageOverview from "../subscriptions/UsageOverview";
import QuotaBubble from "../subscriptions/QuotaBubble";
import AgentDisplaySettings from "./AgentDisplaySettings";
import AgentDispatchDefaults from "./AgentDispatchDefaults";
import { BrandMark, IconButton, Switch, Notice, Loading } from "./ui";

import { SettingsDialog as Dialog } from "./ui/Settings";
import { Card } from "./ui/card";

const canReorder = (agent: Agent) =>
  !readOnlyBrowser && agent.installed === true && agent.enabled === true;

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

function AgentCard({ agent, onMove, children }: {
  agent: Agent;
  onMove: (by: number) => void;
  children: ReactNode;
}) {
  const controls = useDragControls();
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : motionTransition();
  if (!canReorder(agent)) {
    return <Card asChild><motion.article className="agent-card" layout="position" transition={transition}>
      {children}
    </motion.article></Card>;
  }
  return (
    <Card asChild><Reorder.Item
      as="article"
      value={agent.agent}
      className="agent-card"
      data-reorderable
      tabIndex={0}
      aria-label={t("reorderAgent", { agent: name(agent) })}
      layout="position"
      transition={transition}
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragElastic={!reduced}
      whileDrag={{ cursor: "grabbing", boxShadow: "var(--shadow-md)" }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary ||
          (event.target as Element).closest("button, a, input, select, textarea, [role='button'], [role='switch']")) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        controls.start(event);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          onMove(["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1);
        }
      }}
    >
      {children}
    </Reorder.Item></Card>
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
  const agent = inventory.items.find((item) => item.agent === selected.agent) || selected;
  const { snapshot } = subscriptions.use();
  const [savingDefaults, setSavingDefaults] = useState(false);
  const provider = snapshot?.settings.enabled
    ? snapshot.providers.find(
        (p) => p.agentIds.includes(agent.agent) && p.eligible,
      )
    : undefined;
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
      {provider && <QuotaBubble provider={provider} />}
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
  function move(id: string, by: number) {
    const list = items.filter(canReorder),
      index = list.findIndex((a) => a.agent === id);
    if (list[index + by]) moveAgent(id, list[index + by]!.agent);
  }
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
        {items.some((agent) => agent.installed) && <>
        <Reorder.Group
          as="div"
          axis="xy"
          className="agent-grid"
          values={items.filter(canReorder).map(agent => agent.agent)}
          onReorder={reorderAgents}
        >
          {items.filter(agent => agent.installed).map((agent) => (
            <AgentCard
              key={agent.agent}
              agent={agent}
              onMove={by => move(agent.agent, by)}
            >
              <button
                type="button"
                className="agent-detail-trigger"
                aria-label={name(agent)}
                aria-haspopup="dialog"
                onClick={() => setDetail(agent)}
              >
                <BrandMark markup={icons[agent.agent]} />
              </button>
              <div className="agent-copy">
                {agentLinks[agent.agent] ? (
                  <a
                    href={agentLinks[agent.agent]}
                    draggable={false}
                    onClick={(e) => {
                      e.preventDefault();
                      void openUrl(agentLinks[agent.agent]!).catch((e) =>
                        setError(String(e)),
                      );
                    }}
                  >
                    {name(agent)}
                  </a>
                ) : (
                  <strong>{name(agent)}</strong>
                )}
                <HoverHelp text={agent.version || undefined}><span>
                  {[compactAgentVersion(agent.version), readiness(agent)].filter(Boolean).join(" · ")}
                </span></HoverHelp>
              </div>
              {agent.installed && (
                <Switch
                  label={t("allowConnectorToUseValue", { agent: name(agent) })}
                  checked={agent.enabled === true}
                  disabled={
                    readOnlyBrowser || !!state.saving ||
                    state.loading ||
                    agent.adapter?.state === "preparing" ||
                    typeof agent.enabled !== "boolean"
                  }
                  onChange={(enabled) => void toggleAgent(agent, enabled)}
                />
              )}
              {agent.installed &&
                agent.adapter &&
                agent.adapter.state !== "ready" && (
                  <p
                    className="agent-adapter"
                    role={agent.adapter.state === "failed" ? "alert" : "status"}
                  >
                    {t(
                      agent.adapter.state === "preparing"
                        ? "agentAdapterPreparing"
                        : agent.adapter.state === "failed"
                          ? "agentAdapterFailed"
                          : "agentAdapterMissing",
                    )}
                    {agent.adapter.error &&
                      ` · ${t({ CLAUDE_ADAPTER_DOWNLOAD_FAILED: "agentAdapterDownloadFailed", CLAUDE_ADAPTER_CHECKSUM_FAILED: "agentAdapterChecksumFailed", CLAUDE_ADAPTER_EXTRACT_FAILED: "agentAdapterExtractFailed", CLAUDE_ADAPTER_PROBE_FAILED: "agentAdapterProbeFailed" }[agent.adapter.error] || "agentAdapterSetupFailed")}`}
                  </p>
                )}
            </AgentCard>
          ))}
        </Reorder.Group>
        </>}
        {items.some((agent) => !agent.installed) && <>
        <h3 className="agent-section-title">{t("notInstalledAgents")}</h3>
        <div className="uninstalled-agents">
          {items.filter(agent => !agent.installed).map(agent => (
            <a
              key={agent.agent}
              className="agent-uninstalled"
              href={agentLinks[agent.agent]}
              onClick={(event) => {
                event.preventDefault();
                void openUrl(agentLinks[agent.agent]!).catch(error => setError(String(error)));
              }}
            >
              <BrandMark markup={icons[agent.agent]} size={24} />
              <span>{name(agent)}</span>
            </a>
          ))}
        </div>
        </>}
        {error && <Notice>{error}</Notice>}
      </Panel>
      {detail && (
        <AgentDetails showOfficialLink agent={detail} onClose={() => setDetail(undefined)} />
      )}{" "}
      {overview && <UsageOverview onClose={() => setOverview(false)} onNavigate={() => { setOverview(false); setDisplay(true); }} />}
      {display && <AgentDisplaySettings onClose={() => setDisplay(false)} />}
    </>
  );
}

import { useState } from "react";
import { RefreshCw, Settings, Gauge } from "lucide-react";
import { t } from "../i18n";
import { openUrl } from "../platform";
import {
  agents,
  orderedAgents,
  moveAgent,
  name,
  agentLinks,
  toggleAgent,
  refreshAgents,
  type Agent,
} from "../state/agents";
import { subscriptions } from "../state/subscriptions";
import { AgentQuotaIcon } from "../subscriptions/QuotaRing";
import UsageOverview from "../subscriptions/UsageOverview";
import QuotaBubble from "../subscriptions/QuotaBubble";
import AgentDisplaySettings from "./AgentDisplaySettings";
import { Dialog, IconButton, Switch, Notice, Loading } from "./ui";
export function AgentDetails({
  agent,
  onClose,
  showOfficialLink = false,
}: {
  agent: Agent;
  showOfficialLink?: boolean;
  onClose: () => void;
}) {
  const { snapshot } = subscriptions.use();
  const provider = snapshot?.settings.enabled
    ? snapshot.providers.find(
        (p) => p.agentId === agent.agent && p.eligible,
      )
    : undefined;
  return (
    <Dialog title={name(agent)} onClose={onClose} headerless width={440}>
      <div className="agent-summary">
        <AgentQuotaIcon agent={agent.agent} />
        <div>
          <strong>{name(agent)}</strong>
          <p>{agent.installed ? agent.version : t("agentNotInstalled")}</p>
        </div>
      </div>
      {showOfficialLink && agentLinks[agent.agent] && <a href={agentLinks[agent.agent]} onClick={e => { e.preventDefault(); void openUrl(agentLinks[agent.agent]!); }}>{t("officialSetup")}</a>}
      {provider && <QuotaBubble provider={provider} />}
    </Dialog>
  );
}
export default function AgentsSettings({ onClose }: { onClose: () => void }) {
  const state = agents.use(),
    items = orderedAgents();
  const [detail, setDetail] = useState<Agent>(),
    [display, setDisplay] = useState(false),
    [overview, setOverview] = useState(false),
    [dragging, setDragging] = useState(""),
    [dropTarget, setDropTarget] = useState(""),
    [error, setError] = useState("");
  const canReorder = (agent: Agent) =>
    agent.installed === true && agent.enabled === true;
  function move(id: string, by: number) {
    const list = items.filter(canReorder),
      index = list.findIndex((a) => a.agent === id);
    if (list[index + by]) moveAgent(id, list[index + by]!.agent);
  }
  return (
    <>
      <Dialog
        title={t("agents")}
        onClose={onClose}
        wide
        actions={
          <>
            <IconButton icon={Gauge} label={t("trayUsage")} onClick={() => setOverview(true)} />
            <IconButton
              icon={Settings}
              label={t("agentDisplaySettings")}
              onClick={() => setDisplay(true)}
            />
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
        {!state.loaded && state.loading && <Loading />}
        <h3 className="agent-section-title">{t("installedAgents")}</h3>
        <div className="agent-grid">
          {items.filter(agent => agent.installed).map((agent) => (
            <article
              key={agent.agent}
              className={`agent-card ${dragging === agent.agent ? "dragging" : ""} ${dropTarget === agent.agent ? "drop-target" : ""}`}
              tabIndex={canReorder(agent) ? 0 : -1}
              aria-label={
                canReorder(agent)
                  ? t("reorderAgent", { agent: name(agent) })
                  : name(agent)
              }
              draggable={canReorder(agent)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (
                  ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(
                    e.key,
                  )
                ) {
                  e.preventDefault();
                  move(
                    agent.agent,
                    ["ArrowUp", "ArrowLeft"].includes(e.key) ? -1 : 1,
                  );
                }
              }}
              onDragStart={(e) => {
                setDragging(agent.agent);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", agent.agent);
              }}
              onDragEnd={() => {
                setDragging("");
                setDropTarget("");
              }}
              onDragOver={(e) => {
                if (dragging && canReorder(agent)) {
                  e.preventDefault();
                  setDropTarget(agent.agent);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && canReorder(agent))
                  moveAgent(dragging, agent.agent);
                setDragging("");
                setDropTarget("");
              }}
            >
              <button
                type="button"
                className="agent-detail-trigger"
                aria-label={name(agent)}
                aria-haspopup="dialog"
                onClick={() => setDetail(agent)}
              >
                <AgentQuotaIcon agent={agent.agent} />
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
                <span title={agent.version || undefined}>
                  {agent.installed ? agent.version : t("agentNotInstalled")}
                </span>
              </div>
              {agent.installed && (
                <Switch
                  label={t("allowConnectorToUseValue", { agent: name(agent) })}
                  checked={agent.enabled === true}
                  disabled={
                    !!state.saving ||
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
            </article>
          ))}
        </div>
        <h3 className="agent-section-title">{t("notInstalledAgents")}</h3>
        <div className="uninstalled-agents">{items.filter(agent => !agent.installed).map(agent => <button key={agent.agent} className="agent-uninstalled" onClick={() => setDetail(agent)} aria-haspopup="dialog"><AgentQuotaIcon agent={agent.agent} /><span>{name(agent)}</span></button>)}</div>
        {(error || state.error) && <Notice>{error || state.error}</Notice>}
      </Dialog>
      {detail && (
        <AgentDetails showOfficialLink agent={detail} onClose={() => setDetail(undefined)} />
      )}{" "}
      {overview && <Dialog title={t("trayUsage")} onClose={() => setOverview(false)} width={440}>
        <UsageOverview onNavigate={() => { setOverview(false); setDisplay(true); }} />
      </Dialog>}
      {display && <AgentDisplaySettings onClose={() => setDisplay(false)} />}
    </>
  );
}

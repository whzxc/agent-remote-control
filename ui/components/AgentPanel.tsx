import { useReducedMotion } from "../state/appEnvironment";
import { agentPanel, selectAgentPanel, agentPanelId } from "../state/overviewPanels";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, Settings, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { useAccounts, refreshAccounts } from "../state/accounts";
import { accountQuotaProvider } from "../subscriptions/accountQuota";
import AgentQuota from "./AgentQuota";
import { agentActivity } from "../state/activity";
import { refreshSubscription, subscriptions } from "../state/subscriptions";
import { compactAgentVersion, name, type Agent } from "../state/agents";
import { connector } from "../state/connector";
import { AgentQuotaIcon } from "../subscriptions/QuotaRing";
import { errorLabels } from "../subscriptions/presentation";
import { Button, Dialog, IconButton, Notice } from "./ui";
import AgentPlatformView from "./AgentPlatformView";
import AgentConversations from "./AgentConversations";
import ActivityTimeline from "./ActivityTimeline";
import type { SurfaceRect } from "../motion/surface";
import type { ProviderAccount } from "../types";
import { accountOwns } from "../accountPresentation";

function AgentView({ agent, account, accountId, onSettings, expanded, onToggleWidth, active, platformAvailable, resizable = true }: {
  agent: Agent; active: boolean; platformAvailable: boolean; resizable?: boolean; account?: ProviderAccount; accountId?: string;
  onSettings: () => void; expanded: boolean; onToggleWidth: () => void;
}) {
  const { snapshot } = subscriptions.use(), { status } = connector.use();
  const activity = agentActivity.use().snapshot;
  const [error, setError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const provider = accountId ? account ? accountQuotaProvider(agent.agent, account.quota) : undefined
    : snapshot?.settings.enabled ? snapshot.providers.find(p => p.agentIds.includes(agent.agent) && p.eligible) : undefined;
  const title = account?.alias ?? name(agent);
  const sessions = activity?.agents[agent.agent]?.sessions.filter(session => !accountId || (account
    ? accountOwns(account, session.agentAccountId ?? session.dispatchSummary?.agentAccountId)
    : (session.agentAccountId ?? session.dispatchSummary?.agentAccountId) === accountId)) ?? [];
  const providerError = provider?.error && !["no-subscription", "no-limits-reported", "unsupported-platform"].includes(provider.error.code)
    ? provider.error.message || t(errorLabels[provider.error.code] || "usageUnavailable") : undefined;
  async function refresh() {
    if (!provider) return;
    setRefreshing(true); setError("");
    try { if (accountId) await refreshAccounts(); else await refreshSubscription(provider.providerId); }
    catch (error) { setError(String(error)); }
    finally { setRefreshing(false); }
  }
  return <section className="agent-panel-layer agent-overview-layer">
    <header className="dialog-header agent-panel-header">
      {platformAvailable ? <Button variant="link" aria-label={name(agent)} onClick={() => selectAgentPanel({ type: "platform", agent: agent.agent })}><AgentQuotaIcon agent={agent.agent} quota={accountId ? account?.quota ?? null : undefined} dual /></Button>
        : <AgentQuotaIcon agent={agent.agent} quota={accountId ? account?.quota ?? null : undefined} dual />}
      <div className="agent-panel-heading">
        <div className="agent-panel-title-row">
          <h2 className="activity-panel-title" tabIndex={-1} title={title}>{title}</h2>
          {agent.installed && status?.platform && status.platform !== "linux" && <IconButton icon={ArrowUpRight} label={t("activity.open")} onClick={() => {
            setError(""); void api("agents/open", "POST", { agent: agent.agent }).catch(error => setError(String(error)));
          }} />}
        </div>
        <span className="activity-panel-meta" title={agent.version || undefined}>{[compactAgentVersion(agent.version), t("agentPanel.inProgress", { count: sessions.length })].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="actions">
        <IconButton icon={Settings} label={t("agentDisplaySettings")} onClick={onSettings} />
        {resizable && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")}
          aria-pressed={expanded} onClick={onToggleWidth} />}
      </div>
    </header>
    <div className="agent-view-scroll">
      {error && <p className="timeline-error" role="alert">{error}</p>}
      {providerError && <Notice action={<IconButton icon={RefreshCw} size={16} label={t("usageRefresh")}
        busy={refreshing || provider?.refreshing} onClick={() => void refresh()} />}>{providerError}</Notice>}
      {provider ? <AgentQuota provider={provider} onRefresh={() => void refresh()} refreshing={refreshing} /> : <p className="timeline-meta agent-no-quota">{t("agentPanel.noQuota")}</p>}
      <AgentConversations key={`${agent.agent}:${accountId ?? ""}`} agent={agent.agent} account={account} accountId={accountId} active={active} />
    </div>
  </section>;
}

export default function AgentPanel({ agent, onSettings, onPanelFrame, width, expanded, onToggleWidth, dockRect }: {
  agent: Agent; width?: number; dockRect?: SurfaceRect;
  onSettings: () => void; onPanelFrame: (rect: SurfaceRect | null) => void;
  expanded: boolean; onToggleWidth: () => void;
}) {
  const selected = agentPanel.use()!, { error } = agentActivity.use();
  const accountState = useAccounts(), account = accountState.items.find(account => accountOwns(account, selected.accountId));
  const linkedAccounts = accountState.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));
  useLayoutEffect(() => {
    if (selected.platform && !selected.closing && !accountState.loading && linkedAccounts.length <= 1) selectAgentPanel({ type: 'agent', agent: agent.agent, accountId: linkedAccounts[0]?.id });
  }, [selected.platform, selected.closing, accountState.loading, linkedAccounts.length, linkedAccounts[0]?.id, agent.agent]);
  const reduced = useReducedMotion(), previous = useRef(selected), content = useRef<HTMLDivElement>(null);
  const session = selected.session, taskTitleId = useId();
  const returning = !selected.platform && previous.current.agent === selected.agent && previous.current.accountId === selected.accountId && !!previous.current.session && !session;
  useLayoutEffect(() => {
    if (returning) {
      const id = previous.current.session!.id;
      requestAnimationFrame(() => {
        const row = Array.from(content.current?.querySelectorAll<HTMLButtonElement>("[data-activity-session]") ?? [])
          .find(node => node.dataset.activitySession === JSON.stringify([selected.agent, id]));
        (row ?? content.current?.querySelector<HTMLElement>(".agent-overview-layer h2"))?.focus({ preventScroll: true });
      });
    }
    previous.current = selected;
  }, [selected]);
  const panelId = agentPanelId(selected);
  return <Dialog width={width} dockRect={dockRect} dock="right" expanded={expanded} headerless title={account?.alias ?? name(agent)} labelledBy={session ? taskTitleId : undefined}
    originKey={panelId} closeRequested={selected.closing}
    onCloseStart={() => agentPanel.set(old => old && agentPanelId(old) === panelId ? { ...old, closing: true } : old)}
    onClose={() => { const current = agentPanel.get(); if (current && agentPanelId(current) === panelId && current.closing) selectAgentPanel({ type: "closed" }); }}
    returnFocus={selected.platform ? `[data-agent-platform="${CSS.escape(agent.agent)}"] button` : `[data-agent-node="${CSS.escape(agent.agent)}"]${selected.accountId ? `[data-account-id="${CSS.escape(account?.id ?? selected.accountId)}"]` : ""} button`} onPanelFrame={onPanelFrame}>
    {error && <span className="sr-only" role="status">{t("activity.disconnected")}</span>}
    <div ref={content} className="agent-panel-view">
      <motion.div className="agent-panel-view" key={panelId} style={{ display: session ? "none" : "flex" }}
        initial={{ opacity: reduced ? 1 : 0, x: 0 }} animate={{ opacity: session ? 0 : 1, x: reduced || !session ? 0 : -12 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        {selected.platform ? <AgentPlatformView agent={agent} widthControl={!dockRect && <IconButton icon={expanded ? Minimize2 : Maximize2}
          label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')} aria-pressed={expanded} onClick={onToggleWidth} />} /> : <AgentView platformAvailable={linkedAccounts.length > 1} resizable={!dockRect} agent={agent} account={account} accountId={selected.accountId} active={!session} onSettings={onSettings} expanded={expanded} onToggleWidth={onToggleWidth} />}
      </motion.div>
      {session && <motion.div className="agent-panel-view" key={`${agent.agent}:${session.id}`}
        initial={{ opacity: reduced ? 1 : 0, x: reduced ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        <ActivityTimeline resizable={!dockRect} titleId={taskTitleId} agent={agent.agent} session={session} expanded={expanded} onToggleWidth={onToggleWidth} onBack={() => selectAgentPanel({ type: "back" })} />
      </motion.div>}
    </div>
  </Dialog>;
}

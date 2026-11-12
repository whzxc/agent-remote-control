import { Tooltip as HoverHelp } from "./ui/index";
import { layerTrigger } from "../state/layers";
import Panel, { PanelHeader, usePanelState } from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import PetPicker from '../pets/PetPicker';
import { controlSourcePlatform } from '../controlSources';
import { agentPanel, panelBack, selectAgentPanel, agentPanelId, managesAgentAccounts } from "../state/overviewPanels";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Settings, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { useAccounts, refreshAccountQuota } from "../state/accounts";
import { accountQuotaProvider } from "../subscriptions/accountQuota";
import AgentQuota from "./AgentQuota";
import { agentActivity } from "../state/activity";
import { platformQuotaForAgent, refreshSubscription, subscriptions } from "../state/subscriptions";
import { compactAgentVersion, name, type Agent } from "../state/agents";
import { connector } from "../state/connector";
import { AgentQuotaIcon } from "../subscriptions/AgentQuotaIcon";
import { errorLabels } from "../subscriptions/presentation";
import { Button,  IconButton, Notice } from "./ui";
import AgentPlatformView from "./AgentPlatformView";
import AgentConversations, { readConversationPage, type InitialAgentHistory } from "./AgentConversations";
import { useDockOpening } from "./useDockOpening";
import ActivityTimeline from "./ActivityTimeline";
import type { LayerRect } from "./ui/layerFrame";
import type { ProviderAccount } from "../types";
import { accountOwns } from "../accountPresentation";

function AgentView({ agent, account, accountId, onSettings, expanded, onToggleWidth, active, platformAvailable, resizable = true, initial }: {
  agent: Agent; active: boolean; platformAvailable: boolean; resizable?: boolean; account?: ProviderAccount; accountId?: string;
  onSettings: () => void; expanded: boolean; onToggleWidth: () => void; initial?: InitialAgentHistory;
}) {
  const { snapshot } = subscriptions.use(), { status } = connector.use();
  const activity = agentActivity.use().snapshot;
  const [error, setError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const accountQuota = account && (managesAgentAccounts(agent.agent) || accountId !== undefined || account.quota.windows.length > 0);
  const provider = accountQuota ? accountQuotaProvider(agent.agent, account.quota)
    : accountId ? undefined : platformQuotaForAgent(snapshot, agent.agent);
  const title = account?.alias ?? name(agent);
  const sessions = activity?.agents[agent.agent]?.sessions.filter(session => !accountId || (account
    ? accountOwns(account, session.agentAccountId ?? session.dispatchSummary?.agentAccountId)
    : (session.agentAccountId ?? session.dispatchSummary?.agentAccountId) === accountId)) ?? [];
  const providerError = provider?.error && !["no-subscription", "no-limits-reported", "unsupported-platform"].includes(provider.error.code)
    ? provider.error.message || t(errorLabels[provider.error.code] || "usageUnavailable") : undefined;
  async function refresh() {
    if (!provider) return;
    setRefreshing(true); setError("");
    try { if (accountQuota) await refreshAccountQuota(account.id); else await refreshSubscription(provider.providerId); }
    catch (error) { setError(String(error)); }
    finally { setRefreshing(false); }
  }
  const quotaBusy = refreshing || !!provider?.refreshing;
  usePanelState({ busy: quotaBusy });
  return <section className="agent-panel-layer agent-overview-layer">
    <PanelHeader active={active}><header className="dialog-header agent-panel-header">
      {platformAvailable ? <Button variant="link" disabled={quotaBusy} aria-label={name(agent)} onClick={() => selectAgentPanel({ type: "platform", agent: agent.agent })}><AgentQuotaIcon agent={agent.agent} provider={provider} /></Button>
        : <AgentQuotaIcon agent={agent.agent} provider={provider} />}
      <div className="agent-panel-heading">
        <div className="agent-panel-title-row">
          <HoverHelp text={title}><h2 className="activity-panel-title" tabIndex={-1}>{title}</h2></HoverHelp>
          {!readOnlyBrowser && agent.installed && status?.platform && status.platform !== "linux" && <IconButton icon={ArrowUpRight} label={t("activity.open")} onClick={() => {
            setError(""); void api("agents/open", "POST", { agent: agent.agent }).catch(error => setError(String(error)));
          }} />}
        </div>
        <HoverHelp text={agent.version || undefined}><span className="activity-panel-meta">{[compactAgentVersion(agent.version), t("agentPanel.inProgress", { count: sessions.length })].filter(Boolean).join(" · ")}</span></HoverHelp>
      </div>
      <div className="actions">
        {provider && !readOnlyBrowser && <IconButton icon={RefreshCw} label={t("usageRefresh")} busy={quotaBusy}
          disabled={!provider.eligible} onClick={() => void refresh()} />}
        <PetPicker scope={`agent:${agent.agent}`} name={name(agent)} platform={controlSourcePlatform(agent.agent).id} />
        <IconButton icon={Settings} label={t("agentDisplaySettings")} disabled={quotaBusy} onClick={onSettings} />
        {resizable && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")}
          aria-pressed={expanded} onClick={onToggleWidth} />}
      </div>
    </header></PanelHeader>
    <div className="agent-view-scroll">
      {error && <p className="timeline-error" role="alert">{error}</p>}
      {providerError && <Notice>{providerError}</Notice>}
      {provider ? <AgentQuota provider={provider} /> : <p className="timeline-meta agent-no-quota">{t("agentPanel.noQuota")}</p>}
      <AgentConversations key={`${agent.agent}:${accountId ?? ""}`} agent={agent.agent} account={account} accountId={accountId} active={active} initial={initial} />
    </div>
  </section>;
}

export default function AgentPanel({ selection: selected, active, agent, onSettings, onPanelFrame, expanded, onToggleWidth }: {
  selection: NonNullable<ReturnType<typeof agentPanel.get>>; active: boolean; agent: Agent; onSettings: () => void; onPanelFrame?: (rect: LayerRect | null) => void;
  expanded: boolean; onToggleWidth: () => void;
}) {
  const back = panelBack.use();
  const focusTrigger = useRef(layerTrigger());
  const { error } = agentActivity.use();
  const accountState = useAccounts();
  const linkedAccounts = accountState.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));
  const account = accountState.items.find(account => accountOwns(account, selected.accountId)) ?? (linkedAccounts.length === 1 ? linkedAccounts[0] : undefined);
  // A single-account platform opens its Agent history, including native rows without ownership metadata.
  const scopedAccountId = !accountState.loading && linkedAccounts.length === 1 ? undefined : selected.accountId;
  useLayoutEffect(() => {
    if (active && (!managesAgentAccounts(agent.agent) || readOnlyBrowser && linkedAccounts.length === 0) && selected.platform && !selected.closing && !accountState.loading && linkedAccounts.length <= 1) selectAgentPanel({ type: 'agent', agent: agent.agent, accountId: linkedAccounts[0]?.id });
  }, [active, selected.platform, selected.closing, accountState.loading, linkedAccounts.length, linkedAccounts[0]?.id, agent.agent]);
  const previous = useRef(selected), content = useRef<HTMLDivElement>(null);
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
  const [history, setHistory] = useState<(InitialAgentHistory & { panelId: string })>();
  const initial = history?.panelId === panelId ? history : undefined;
  const cancelOpening = useCallback(() => {
    agentPanel.set(current => current && agentPanelId(current) === panelId ? undefined : current);
  }, [panelId]);
  const pending = selected.platform ? accountState.loading : !session && !initial?.result;
  const ready = useDockOpening(panelId, pending, selected.closing, cancelOpening);
  const shouldReadHistory = !ready && !selected.closing && !selected.platform && !session;
  useEffect(() => {
    if (!shouldReadHistory) {
      setHistory(previous => previous?.panelId === panelId ? previous : undefined);
      return;
    }
    let current = true;
    const request = readConversationPage(agent.agent);
    const update = (change: Partial<InitialAgentHistory>) => {
      if (current) setHistory(old => old?.request === request ? { ...old, ...change } : old);
    };
    setHistory({ panelId, request });
    void request.then(page => update({ result: { page } }), error => update({ result: { error: String(error) } }));
    return () => { current = false; };
  }, [agent.agent, panelId, shouldReadHistory]);
  if (!ready) return null;
  return <Panel focusTrigger={focusTrigger.current} side="right" className="activity-panel" expanded={expanded} headerless title={selected.platform ? name(agent) : account?.alias ?? name(agent)} labelledBy={session ? taskTitleId : undefined}
    viewKey={`${panelId}:${session?.id ?? "overview"}`}
    onClose={() => { panelBack.set(undefined); agentPanel.set(undefined); }}
    returnFocus={selected.platform ? `[data-agent-platform="${CSS.escape(agent.agent)}"] button` : `[data-agent-node="${CSS.escape(agent.agent)}"]${selected.accountId ? `[data-account-id="${CSS.escape(account?.id ?? selected.accountId)}"]` : ""} button`} onPanelFrame={onPanelFrame}>
    {error && <span className="sr-only" role="status">{t("activity.disconnected")}</span>}
    <div ref={content} className="agent-panel-view">
      <div className="agent-panel-view dialog-swap" key={panelId} hidden={!!session}>
        {selected.platform ? <AgentPlatformView agent={agent} onSettings={onSettings} widthControl={<IconButton icon={expanded ? Minimize2 : Maximize2}
          label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')} aria-pressed={expanded} onClick={onToggleWidth} />} /> : <AgentView platformAvailable={managesAgentAccounts(agent.agent) && (!readOnlyBrowser || linkedAccounts.length > 0) || linkedAccounts.length > 1} resizable agent={agent} account={account} accountId={scopedAccountId} active={!session} onSettings={onSettings} expanded={expanded} onToggleWidth={onToggleWidth} initial={initial && { ...initial, timedOut: !initial.result }} />}
      </div>
      {session && <div className="agent-panel-view dialog-swap" key={`${agent.agent}:${session.id}`}>
        <ActivityTimeline backLabel={back?.label} resizable titleId={taskTitleId} agent={agent.agent} session={session} expanded={expanded} onToggleWidth={onToggleWidth} onBack={() => selectAgentPanel({ type: "back" })} />
      </div>}
    </div>
  </Panel>;
}

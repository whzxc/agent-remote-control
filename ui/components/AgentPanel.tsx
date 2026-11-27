import { ActivityHeading } from './timeline/TimelineSurface';
import { taskSnapshotElement } from './timeline/taskSnapshotElement';
import { Tooltip as HoverHelp } from "./ui/index";
import Panel, { PanelHeader, usePanelState } from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import { agentPanel, panelBack, selectAgentPanel, agentPanelId, managesAgentAccounts } from "../state/overviewPanels";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Settings, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { refreshAccountQuota, useAccounts } from "../state/accounts";
import { resolveAgentQuota } from "../state/quota";
import AgentQuota from "./AgentQuota";
import { agentActivity } from "../state/activity";
import { refreshSubscription, subscriptions } from "../state/subscriptions";
import { compactAgentVersion, name, type Agent } from "../state/agents";
import { connector } from "../state/connector";
import { AgentQuotaIcon } from "../subscriptions/AgentQuotaIcon";
import { errorLabels, isSoftProviderError } from "../subscriptions/presentation";
import { Button,  IconButton, Notice } from "./ui";
import AgentPlatformView from "./AgentPlatformView";
import AgentConversations, { readConversationPage, type InitialAgentHistory } from "./AgentConversations";
import { useDockOpening } from "./useDockOpening";
import ActivityTimeline from "./ActivityTimeline";
import type { LayerRect } from "../state/layers";

function AgentView({ agent, onSettings, expanded, onToggleWidth, active, platformAvailable, resizable = true, initial }: {
  agent: Agent; active: boolean; platformAvailable: boolean; resizable?: boolean;
  onSettings: () => void; expanded: boolean; onToggleWidth: () => void; initial?: InitialAgentHistory;
}) {
  const { snapshot } = subscriptions.use(), { status } = connector.use();
  const activity = agentActivity.use().snapshot;
  const [error, setError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const { items: accounts } = useAccounts();
  const provider = resolveAgentQuota(agent.agent, snapshot, accounts);
  const title = name(agent);
  const sessions = activity?.agents[agent.agent]?.sessions ?? [];
  const providerError = provider?.error && !isSoftProviderError(provider.error.code)
    ? provider.error.message || t(errorLabels[provider.error.code] || "usageUnavailable") : undefined;
  const providerHint = provider?.error?.code === "client-not-running"
    ? t(errorLabels[provider.error.code]) : undefined;
  async function refresh() {
    if (!provider) return;
    setRefreshing(true); setError("");
    try {
      if (provider.quotaAccountId) await refreshAccountQuota(provider.quotaAccountId);
      else await refreshSubscription(provider.providerId);
    }
    catch (error) { setError(String(error)); }
    finally { setRefreshing(false); }
  }
  const quotaBusy = refreshing || !!provider?.refreshing;
  usePanelState({ busy: quotaBusy });
  return <section className="agent-panel-layer agent-overview-layer">
    <PanelHeader active={active}><header className="dialog-header agent-panel-header">
      {platformAvailable ? <Button variant="link" disabled={quotaBusy} aria-label={name(agent)} onClick={() => selectAgentPanel({ type: "platform", agent: agent.agent })}><AgentQuotaIcon agent={agent.agent} provider={provider} /></Button>
        : <AgentQuotaIcon agent={agent.agent} provider={provider} />}
      <ActivityHeading>
        <div className="agent-panel-title-row">
          <HoverHelp text={title}><h2 className="activity-panel-title" tabIndex={-1}>{title}</h2></HoverHelp>
          {!readOnlyBrowser && agent.installed && status?.platform && status.platform !== "linux" && <IconButton icon={ArrowUpRight} label={t("activity.open")} onClick={() => {
            setError(""); void api("agents/open", "POST", { agent: agent.agent }).catch(error => setError(String(error)));
          }} />}
        </div>
        <HoverHelp text={agent.version || undefined}><span className="activity-panel-meta">{[compactAgentVersion(agent.version), t("agentPanel.inProgress", { count: sessions.length })].filter(Boolean).join(" · ")}</span></HoverHelp>
      </ActivityHeading>
      <div className="actions">
        {provider && !readOnlyBrowser && <IconButton icon={RefreshCw} label={t("usageRefresh")} busy={quotaBusy}
          disabled={!provider.eligible} onClick={() => void refresh()} />}
        <IconButton icon={Settings} label={t("agentDisplaySettings")} disabled={quotaBusy} onClick={onSettings} />
        {resizable && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")}
          aria-pressed={expanded} onClick={onToggleWidth} />}
      </div>
    </header></PanelHeader>
    <div className="agent-view-scroll">
      {error && <p className="timeline-error" role="alert">{error}</p>}
      {providerError && <Notice>{providerError}</Notice>}
      {providerHint && <p className="timeline-meta agent-no-quota" role="status">{providerHint}</p>}
      {provider ? (providerHint && !provider.windows.some(window => Number.isFinite(window.usedPercent)) ? null : <AgentQuota provider={provider} />)
        : <p className="timeline-meta agent-no-quota">{t("agentPanel.noQuota")}</p>}
      <AgentConversations key={agent.agent} agent={agent.agent} active={active} initial={initial} />
    </div>
  </section>;
}

export default function AgentPanel({ selection: selected, active, agent, onSettings, onPanelFrame, expanded, onToggleWidth }: {
  selection: NonNullable<ReturnType<typeof agentPanel.get>>; active: boolean; agent: Agent; onSettings: () => void; onPanelFrame?: (rect: LayerRect | null) => void;
  expanded: boolean; onToggleWidth: () => void;
}) {
  const back = panelBack.use();
  const { error } = agentActivity.use();
  const accountState = useAccounts();
  const linkedAccounts = accountState.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));
  useLayoutEffect(() => {
    if (active && (!managesAgentAccounts(agent.agent) || readOnlyBrowser && linkedAccounts.length === 0) && selected.platform && !selected.closing && !accountState.loading) selectAgentPanel({ type: 'agent', agent: agent.agent });
  }, [active, selected.platform, selected.closing, accountState.loading, linkedAccounts.length, agent.agent]);
  const previous = useRef(selected), content = useRef<HTMLDivElement>(null);
  const session = selected.session, taskTitleId = useId();
  const returning = !selected.platform && previous.current.agent === selected.agent && !!previous.current.session && !session;
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
  return <Panel size="m" className="activity-panel" expanded={expanded} headerless title={name(agent)} labelledBy={session ? taskTitleId : undefined}
    viewKey={`${panelId}:${session?.id ?? "overview"}`}
    onClose={() => { panelBack.set(undefined); agentPanel.set(undefined); }}
    returnFocus={session && taskSnapshotElement(JSON.stringify([agent.agent, session.id])) ? `[data-task-snapshot="${CSS.escape(JSON.stringify([agent.agent, session.id]))}"] [data-task-open]` : selected.platform ? `[data-agent-platform="${CSS.escape(agent.agent)}"] button` : `[data-agent-node="${CSS.escape(agent.agent)}"] button`} onPanelFrame={onPanelFrame}>
    {error && <span className="sr-only" role="status">{t("activity.disconnected")}</span>}
    <div ref={content} className="agent-panel-view">
      <div className="agent-panel-view dialog-swap" key={panelId} hidden={!!session}>
        {selected.platform ? <AgentPlatformView agent={agent} onSettings={onSettings} widthControl={<IconButton icon={expanded ? Minimize2 : Maximize2}
          label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')} aria-pressed={expanded} onClick={onToggleWidth} />} /> : <AgentView platformAvailable={managesAgentAccounts(agent.agent) && (!readOnlyBrowser || linkedAccounts.length > 0)} resizable agent={agent} active={!session} onSettings={onSettings} expanded={expanded} onToggleWidth={onToggleWidth} initial={initial && { ...initial, timedOut: !initial.result }} />}
      </div>
      {session && <div className="agent-panel-view dialog-swap" key={`${agent.agent}:${session.id}`}>
        <ActivityTimeline backLabel={back?.label} resizable titleId={taskTitleId} agent={agent.agent} session={session} expanded={expanded} onToggleWidth={onToggleWidth} onBack={() => selectAgentPanel({ type: "back" })} />
      </div>}
    </div>
  </Panel>;
}

import { useRelays, publicRelay } from "../state/relay";
import { useAppNow } from "../state/appEnvironment";
import { appEnvironment, envOverrides } from "../state/appEnvironment";
import { accountViews, canonicalAccount } from '../topology/accountViews';
import { topologyAccountOrder } from '../topology/accountState';
import { useAccounts } from '../state/accounts';
import { agentPanel, selectAgentPanel, ingressPanel, selectSourcePanel } from "../state/overviewPanels";
import { resetActivityCore, useActivityTracking } from "../state/activity";
import { subscriptions } from "../state/subscriptions";
import { navigation } from "../state/navigation";
import {
  useEffect,
  useState,
  useRef,
} from "react";
import { Power, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { Button, Icon, Notice } from "./ui";
import { api } from "../api";
import { connector, run, refreshConnector, orderedSources } from "../state/connector";
import {
  agents as agentStore,
  orderedAgents,
} from "../state/agents";
import { isPendingSource } from "../sourcePresentation";
import Topology from "../topology/Topology";
import { PANEL_MIN_WIDTH } from "../topology/solve";
import Onboarding from "./Onboarding";
import { onboarding, openOnboarding } from "../state/onboarding";
import IngressPanel from "./IngressPanel";
import AgentsSettings from "./AgentsSettings";
import AgentPanel from "./AgentPanel";
import type { AgentConversation, AgentConversationPage } from "../types";
import Hub from "../topology/Hub";
export default function ConnectionOverview({ visible = true }: { visible?: boolean }) {
  const { tracked, markRead } = useActivityTracking(), selection = agentPanel.use(), sourceSelection = ingressPanel.use();
  const flow = onboarding.use();
  const detailOpen = !!selection || !!sourceSelection, panelOpen = detailOpen || !!flow;
  const [panelExpanded, setPanelExpanded] = useState(false);
  appEnvironment.use();
  useEffect(() => { if (!detailOpen) setPanelExpanded(false); }, [detailOpen]);
  const { status, sources: sourceRecords, sourcesLoaded, busy, loading, error } = connector.use();
  const inventory = agentStore.use();
  const { items: accounts } = useAccounts(), accountOrders = topologyAccountOrder.use();
  const { snapshot } = subscriptions.use(), nav = navigation.use();
  const [agentsOpen, setAgentsOpen] = useState(false);
  const initialSetupShown = useRef(false);
  useEffect(() => {
    if (!visible || initialSetupShown.current || !status || !sourcesLoaded || loading || error) return;
    initialSetupShown.current = true;
    if (!flow && !detailOpen && !sourceRecords.some(s => s.state !== "revoked" && !isPendingSource(s, status.ingresses))) openOnboarding("welcome");
  }, [visible, status, sourceRecords, sourcesLoaded, loading, error, flow, detailOpen]);
  const sources = status?.ingresses ?? [];
  const controlSources = orderedSources().filter(s => s.state !== "revoked" && !isPendingSource(s, sources));
  const agents = orderedAgents().filter(a => a.installed && a.enabled === true);
  const relays = useRelays();
  const publicId = publicRelay(relays.relays)?.ingressId;
  const basicConnections = sources.filter(entry => entry.transport === "local" || entry.id === publicId);
  const running = basicConnections.some((i) => i.running),
    progressing =
      !!busy || basicConnections.some((i) => ["starting", "stopping"].includes(i.state));
  function edit() { openOnboarding("product"); }
  async function toggle() {
    if (busy) return;
    if (
      !running &&
      (!basicConnections.length || basicConnections.every((i) => !i.config.configured))
    ) {
      edit();
      return;
    }
    await run("basic-connections", async () => {
      const failures: string[] = [];
      for (const entry of basicConnections) {
        try {
          if (!running && !entry.enabled) await api(`ingress/${entry.id}`, "PUT", { enabled: true });
          await api(`ingress/${entry.id}/${running ? "stop" : "start"}`, "POST"); }
        catch (error) { failures.push(`${entry.name}: ${String(error)}`); }
      }
      await refreshConnector();
      if (failures.length) throw new Error(failures.join("\n"));
    });
  }

  useEffect(() => {
    if (nav.providerId === undefined) return;
    if (nav.providerId === "") {
      setAgentsOpen(true);
      navigation.set((old) => ({ ...old, providerId: undefined }));
      return;
    }
    const provider = snapshot?.providers.find(
      (p) => p.providerId === nav.providerId,
    );
    const agent = orderedAgents().find((a) => a.agent === nav.providerId || a.agent === provider?.agentId)
      ?? (provider ? { agent: provider.agentId, displayName: provider.name } : undefined);
    if (!agent) return;
    selectAgentPanel({ type: "agent", agent: agent.agent });
    navigation.set((old) => ({ ...old, providerId: undefined }));
  }, [nav.providerId, snapshot, inventory.items]);
  const now = useAppNow(visible && Object.values(tracked).some(s => s.length) ? 1000 : 60_000);
  useEffect(() => { if (status?.core.backendSession) resetActivityCore(status.core.backendSession); }, [status?.core.backendSession]);
  const selectedAgent = selection && (orderedAgents().find(a => a.agent === selection.agent) ?? { agent: selection.agent });
  const [switchOn, setSwitchOn] = useState<boolean>();
  useEffect(() => { if (!progressing && status) setSwitchOn(running); }, [running, progressing, status]);
  const openAccountNode = (side: -1 | 1, platform: string, sourceId?: string, accountId?: string) => {
    if (side === 1) {
      selectAgentPanel({ type: 'toggle', agent: platform, accountId });
    } else {
      const source = controlSources.find(s => s.id === sourceId);
      selectSourcePanel(platform, { toggle: true, sourceId: source?.id, accountId });
    }
  };
  const callerKeys = JSON.stringify([...new Set(Object.values(tracked).flatMap(rows => rows.flatMap(s => s.dispatchSummary?.caller ? [JSON.stringify(s.dispatchSummary.caller)] : [])))].sort());
  const [callerConversations, setCallerConversations] = useState<{ agent: string; conversation: AgentConversation }[]>([]);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const callers = (JSON.parse(callerKeys) as string[]).map(key => JSON.parse(key) as { agent: string; conversationId: string });
    void Promise.all([...new Set(callers.map(c => c.agent))].map(async agent => {
      const wanted = new Set(callers.filter(c => c.agent === agent).map(c => c.conversationId));
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api<AgentConversationPage>('agents/conversations', 'POST', { agent, limit: 50, ...(cursor ? { cursor } : {}) });
        if (stopped) return;
        const matched = page.data.filter(c => wanted.has(c.nativeSessionId ?? c.id) || wanted.has(c.id));
        matched.forEach(c => { wanted.delete(c.nativeSessionId ?? c.id); wanted.delete(c.id); });
        if (matched.length) setCallerConversations(old => [...new Map([...old, ...matched.map(conversation => ({ agent, conversation }))].map(row => [JSON.stringify([row.agent, row.conversation.id]), row])).values()]);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor && wanted.size && !stopped);
    })).catch(console.error);
    return () => { stopped = true; };
  }, [callerKeys, visible]);
  const conversations = callerConversations.map(row => ({ ...row, conversation: { ...row.conversation, agentAccountId: canonicalAccount(accounts, row.conversation.agentAccountId) } }));
  const candidates = accountViews({ sources: controlSources, agents, accounts, orders: accountOrders, open: openAccountNode });
  const sessions = Object.entries(tracked).flatMap(([agent, rows]) => rows.map(session => ({ agent, session: { ...session,
    agentAccountId: canonicalAccount(accounts, session.agentAccountId),
    dispatchSummary: session.dispatchSummary && { ...session.dispatchSummary, agentAccountId: canonicalAccount(accounts, session.dispatchSummary.agentAccountId) ?? undefined,
      controlSource: session.dispatchSummary.controlSource && { ...session.dispatchSummary.controlSource, accountId: canonicalAccount(accounts, session.dispatchSummary.controlSource.accountId) ?? undefined } } } })));
  return (
    <>
      <section inert={flow?.step === "welcome"} aria-hidden={flow?.step === "welcome" || undefined} className={`connection-core brand-mode ${panelOpen ? "side-panel-open" : ""}`} aria-label={t("connectionStatus")}>
        <div className="core-toggle">
          <Button variant="surface"
            className={`connection-action ${switchOn ? "is-on" : ""} ${progressing ? "is-busy" : ""}`}
            disabled={progressing || loading || !status || !!error}
            aria-busy={progressing}
            aria-label={t(
              progressing ? "pleaseWait" : running ? "disconnect" : "connect",
            )}
            onClick={() => void toggle()}
          >
            <span className="connection-switch-track" aria-hidden="true">
              <span className="connection-knob">
                <Icon icon={progressing ? LoaderCircle : Power} />
              </span>
            </span>
          </Button>
        </div>
        <Topology candidates={candidates} sessions={sessions} conversations={conversations} now={now} onRead={markRead}
          brand={<Hub sourceEmpty={!controlSources.length} agentEmpty={!agents.length}
            onAddSource={() => openOnboarding("product")}
            onManageAgents={() => setAgentsOpen(true)} />} />
        {selectedAgent && visible && <AgentPanel agent={selectedAgent}
          width={envOverrides().taskPanelWidth ?? PANEL_MIN_WIDTH} expanded={envOverrides().taskPanelWidth == null && panelExpanded} onToggleWidth={() => setPanelExpanded(value => !value)} />}
        {sourceSelection && visible && <IngressPanel width={PANEL_MIN_WIDTH} expanded={panelExpanded} onToggleWidth={() => setPanelExpanded(value => !value)} />}

        {error && (
          <div className="graph-error">
            <Notice
              action={
                <Button onClick={() => void refreshConnector().catch(() => {})}>
                  {t("retry")}
                </Button>
              }
            >
              {error}
            </Notice>
          </div>
        )}
      </section>
      {flow && visible && <Onboarding />}
      {agentsOpen && <AgentsSettings onClose={() => setAgentsOpen(false)} />}
    </>
  );
}

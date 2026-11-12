import { markActivitiesRead } from '../state/activityBubbles';
import { orderedSubset } from '../topology/order';
import type { LayerRect } from './ui/layerFrame';
import RemoteTaskPanel from './RemoteTaskPanel';
import { observeHomepage } from '../acceptance';
import { homepageTaskFocus } from '../state/homepage';
import HomepageTasks from './HomepageTasks';
import { homepageMode } from '../state/homepage';
import { useHomepageTasks } from '../state/homepageTasks';
import { deviceLinkEnabled, deviceView } from '../devices/state';
import DeviceNodePanel from '../devices/DeviceNodePanel';
import { PanelRoute } from './ui/Panel';
import { readOnlyBrowser } from "../browserMode";
import { taskExecutions } from "../state/taskExecution";
import { appEnvironment } from "../state/appEnvironment";
import { controlSource, controlSourcePlatform } from '../controlSources';
import { accountViews } from '../topology/accountViews';
import { visibleAgents } from '../topology/visibleAgents';
import { topologyMode, topologyAccountOrder } from '../topology/accountState';
import { useAccounts } from '../state/accounts';
import { agentPanel, selectAgentPanel, ingressPanel, selectIngressPanel, selectSourcePlatform, sourcePanelId, agentPanelId } from "../state/overviewPanels";
import { resetActivityCore, useActivityTracking } from "../state/activity";
import { maxVisibleAgents } from "../subscriptions/displayPreferences";
import { platformQuotaForAgent, subscriptions } from "../state/subscriptions";
import { navigation, openConnections } from "../state/navigation";
import { AgentQuotaIcon } from "../subscriptions/AgentQuotaIcon";
import { accountQuotaProvider } from "../subscriptions/accountQuota";
import {
  useEffect, useCallback,
  useState,
  useRef,
} from "react";
import { t } from "../i18n";
import { ingressState, connector, notify, refreshConnector, refreshHubHealth, orderedSources, reorderSources } from "../state/connector";
import {
  agents as agentStore,
  orderedAgents,
  moveAgent, reorderAgents,
  name,
  type Agent,
} from "../state/agents";
import type { Ingress } from "../state/types";
import SourceIcon from "./SourceIcon";
import { isPendingSource } from "../sourcePresentation";
import GraphNode from "./GraphNode";
import Topology, { type NodeView, type TopologyHandle } from "../topology/Topology";
import type { WireState } from "../topology/render";
import { onboarding, openOnboarding, connectionSetup, connectionSwitch, addedSource } from "../state/onboarding";
import IngressPanel from "./IngressPanel";
import AgentsSettings from "./AgentsSettings";
import AgentDisplaySettings from "./AgentDisplaySettings";
import { Button, Notice } from "./ui";
import AgentPanel from "./AgentPanel";
import ChangeConnection from "./ChangeConnection";
import { ConnectionsPanel } from "./ConnectionsContent";
import Hub from "../topology/Hub";
import HubRecovery, { controlHubCore } from "./HubRecovery";
function wireState(state: string): WireState {
  if (["connected", "agentAvailable"].includes(state)) return "normal";
  if (["connectingLabel", "preparing"].includes(state)) return "connecting";
  if (["connectionError", "unknown"].includes(state)) return "error";
  return "inactive";
}
export default function ConnectionOverview({ visible = true }: { visible?: boolean }) {
  const core = useRef<HTMLDivElement>(null), topology = useRef<TopologyHandle>(null);
  const panelFrame = useCallback((rect: LayerRect | null) => topology.current?.panelFrame(rect), []);
  const homeMode = homepageMode.use(), homepageTasks = useHomepageTasks();
  const homepageObservation = useRef({ mode: homeMode, tasks: homepageTasks });
  homepageObservation.current = { mode: homeMode, tasks: homepageTasks };
  useEffect(() => observeHomepage(() => ({ mode: homepageMode.get(), focus: homepageTaskFocus.get(), tasks: homepageObservation.current.tasks.map(task => ({ key: task.key, agent: task.agent, id: task.session.id, group: task.group, deviceId: task.deviceId, controllerDeviceId: task.controllerDeviceId, step: task.activity.steps.at(-1)?.kind })) })), []);
  const devicesEnabled = deviceLinkEnabled.use(), selectedDevice = deviceView.use();
  taskExecutions.use();
  useActivityTracking();
  const selection = agentPanel.use(), sourceSelection = ingressPanel.use();
  const flow = onboarding.use(), newConnection = connectionSetup.use(), switching = connectionSwitch.use(), nav = navigation.use();
  const newSourceId = addedSource.use();
  useEffect(() => {
    if (!newSourceId || onboarding.get()) return;
    const timer = setTimeout(() => addedSource.set(undefined), 2000);
    return () => clearTimeout(timer);
  }, [newSourceId, flow]);
  const devicePanelOpen = devicesEnabled && !!selectedDevice.detail;
  const detailOpen = !!selection || !!sourceSelection || devicePanelOpen, panelOpen = detailOpen || !!flow || !!newConnection || !!nav.connectionsOpen || !!switching;
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelKey = selection && !selection.closing ? `agent:${agentPanelId(selection)}`
    : sourceSelection && !sourceSelection.closing ? `source:${sourcePanelId(sourceSelection)}` : devicePanelOpen ? `device:${selectedDevice.detail}:${selectedDevice.agent ?? selectedDevice.upstreamSource ?? ""}` : undefined;
  appEnvironment.use();
  useEffect(() => { if (!detailOpen) setPanelExpanded(false); }, [detailOpen]);
  const { status, hubHealth, error } = connector.use();
  const inventory = agentStore.use();
  const { items: accounts } = useAccounts(), mode = topologyMode.use(), accountOrders = topologyAccountOrder.use();
  const max = maxVisibleAgents.use();
  const { snapshot } = subscriptions.use();
  const [agentsOpen, setAgentsOpen] = useState(false), [displaySettingsOpen, setDisplaySettingsOpen] = useState<string | false>(false);
  const sources = status?.ingresses ?? [];
  const controlSources = orderedSources().filter(s => s.state !== "revoked" && !isPendingSource(s, sources));
  const agents = visibleAgents(orderedAgents(), max, selection?.agent);
  const coreState = hubHealth?.core ?? "ready";
  const remoteFailed = (hubHealth?.remoteFaults ?? status?.remoteFaults ?? []).length > 0;
  const [recovery, setRecovery] = useState<"remote" | "core">();
  const [stopping, setStopping] = useState(false);
  async function stopCore() {
    if (stopping) return;
    setStopping(true);
    try {
      await controlHubCore("stop");
    } catch (failure) {
      notify(String(failure), true);
      void refreshHubHealth().catch(() => {});
    } finally {
      setStopping(false);
    }
  }
  function edit(ingress?: Ingress, field?: string) {
    if (ingress) { selectIngressPanel(ingress, { editing: true, field }); return; }
    openOnboarding("product");
  }
  useEffect(() => {
    if (!nav.ingressEdit) return;
    const ingress = status?.ingresses.find((i) => i.id === nav.ingressEdit?.id);
    if (!ingress) return;
    edit(ingress, nav.ingressEdit.field);
    navigation.set((old) => ({ ...old, ingressEdit: undefined }));
  }, [nav.ingressEdit, status?.ingresses]);
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
  function agentState(a: Agent) {
    {
      if (a.adapter?.state === "preparing") return "preparing";
      if (a.adapter?.state === "failed") return "connectionError";
      if (!a.installed || !a.enabled) return "disabled";
    }
    if (a.agent === "codex") {
      const state =
        status?.autoOpenCodex === false
          ? status?.core.appServer.state
          : status?.core.desktop?.state;
      if (state === "ready") return "connected";
      if (state === "error") return "connectionError";
      if (state === "connecting") return "preparing";
      return "disconnected";
    }
    return a.status === "ready"
      ? "connected"
      : a.installed && a.available
        ? "agentAvailable"
        : "connectionError";
  }
  function sourceState(i: Ingress) {
    if (!i.enabled) return "disabled";
    return error ? "unknown" : ingressState(i);
  }
  useEffect(() => { if (status?.core.backendSession) resetActivityCore(status.core.backendSession); }, [status?.core.backendSession]);
  const selectedAgent = selection && (orderedAgents().find(a => a.agent === selection.agent) ?? { agent: selection.agent });
  function moveSource(id: string, by: number) {
    const ids = controlSources.map(source => source.id);
    const index = ids.indexOf(id), target = index + by;
    if (index < 0 || target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, id);
    reorderSources(ids);
  }
  function moveVisibleAgent(id: string, by: number) {
    const enabled = agents.filter(agent => agent.enabled);
    const index = enabled.findIndex(agent => agent.agent === id);
    const target = enabled[index + by];
    if (index >= 0 && target) moveAgent(id, target.agent);
  }
  const sourceViews: NodeView[] = controlSources.flatMap(source => {
    const ingress = sources.find(i => i.id === source.ingressId);
    if (!ingress) return [];
    const state = source.state === "disconnected" ? "disconnected" : sourceState(ingress);
    const selected = !!sourceSelection && !sourceSelection.closing && "ingress" in sourceSelection && sourceSelection.client?.id === source.id;
    const platform = controlSourcePlatform(source.product), platformLabel = platform.displayName;
    const nodeLabel = source.label;
    return [{
      id: source.id, platform: platform.id, platformLabel, label: nodeLabel,
      sourceProduct: source.product, sourceProductLabel: controlSource(source.product)?.displayName ?? source.product,
      icon: <SourceIcon platform={source.product} panelVisual />, sourceIds: [source.id], state: wireState(state), attention: false, selected, reorderable: !readOnlyBrowser && !panelOpen,
      content: <GraphNode label={`${nodeLabel}: ${t(state)}`} state={wireState(state)} highlighted={selected} hideLabel={selected} panelExpanded={selected} caption={<span className="graph-node-name">{nodeLabel}</span>} newlyAdded={source.id === newSourceId && !flow}
        onMove={readOnlyBrowser || panelOpen ? undefined : by => moveSource(source.id, by)}
        onOpen={() => selectIngressPanel(ingress, { toggle: true, client: { id: source.id, name: source.label, source: source.product } })}>
        <SourceIcon platform={platform.id} panelVisual />
      </GraphNode>,
    }];
  });
  const agentViews: NodeView[] = agents.map(agent => {
    const selected = !selection?.closing && selection?.agent === agent.agent;
    const agentAccounts = accounts.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));
    const shared = agentAccounts.length === 1 && agentAccounts[0].quotaProviderId ? agentAccounts[0] : undefined;
    const provider = shared ? accountQuotaProvider(agent.agent, shared.quota) : platformQuotaForAgent(snapshot, agent.agent);
    const icon = <AgentQuotaIcon agent={agent.agent} provider={provider} summary={agent.agent !== "claude"} />;
    return {
      id: agent.agent, platform: agent.agent, platformLabel: name(agent), label: name(agent), icon, quota: provider,
      selectedAccountId: selection?.accountId, state: wireState(agentState(agent)), attention: false, selected, reorderable: !readOnlyBrowser && !panelOpen,
      content: <GraphNode label={`${name(agent)}: ${t(agentState(agent))}`} state={wireState(agentState(agent))}
        onMove={!readOnlyBrowser && agent.enabled && !panelOpen ? by => moveVisibleAgent(agent.agent, by) : undefined}
        highlighted={selected} hideLabel={false} panelExpanded={selected} caption={<span className="graph-node-name">{name(agent)}</span>}
        onOpen={() => selectAgentPanel({ type: 'platform', agent: agent.agent, toggle: true })}>{icon}</GraphNode>,
    };
  });
  const openAccountNode = (side: -1 | 1, platform: string, sourceId?: string, accountId?: string) => {
    if (side === 1) {
      selectAgentPanel({ type: 'toggle', agent: platform, accountId });
    } else {
      const source = controlSources.find(s => s.id === sourceId), ingress = source && sources.find(i => i.id === source.ingressId);
      if (source && ingress) selectIngressPanel(ingress, { toggle: true, client: { id: source.id, name: source.label, source: source.product } });
    }
  };
  const topologyLeft = accountViews(sourceViews, -1, accounts, mode, accountOrders, {
    open: openAccountNode, openPlatform: platform => selectSourcePlatform(platform, true),
    selectedPlatform: sourceSelection && !sourceSelection.closing && 'platform' in sourceSelection ? sourceSelection.platform : undefined,
  });
  const topologyRight = accountViews(agentViews, 1, accounts, mode, accountOrders, {
    open: openAccountNode, openPlatform: agent => selectAgentPanel({ type: 'platform', agent, toggle: true }),
    selectedPlatform: selection?.platform && !selection.closing ? selection.agent : undefined,
  });
  const flatten = (nodes: NodeView[]): NodeView[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
  const reorderNodes = (side: -1 | 1, ids: string[]) => {
    if (readOnlyBrowser) return;
    const nodes = flatten(side === -1 ? topologyLeft : topologyRight), first = nodes.find(n => n.id === ids[0]);
    if (first?.account && !first.sourceProduct) {
      topologyAccountOrder.set(old => ({ ...old, [`${side}:${first.platform}`]: ids.flatMap(id => nodes.find(n => n.id === id)?.accountId ?? []) }));
    } else if (side === -1) reorderSources(orderedSubset(controlSources, ids.flatMap(id => nodes.find(n => n.id === id)?.sourceIds ?? [id])).map(s => s.id));
    else reorderAgents(orderedSubset(agents.map(a => ({ id: a.agent })), ids).map(a => a.id));
  };
  return (
    <div style={{ display: 'contents' }} onPointerDownCapture={event => {
      if (!event.currentTarget.contains(event.target as Node)) topology.current?.memberLayerPointer(event.nativeEvent);
    }}>
      <section inert={flow?.step === "welcome"} aria-hidden={flow?.step === "welcome" || undefined} className={`connection-core brand-mode ${panelOpen ? "side-panel-open" : ""}`} aria-label={t("connectionStatus")}>
        {homeMode === 'tasks' ? <HomepageTasks tasks={homepageTasks} /> : <div className="topology-viewport" ref={core}><Topology ref={topology} boundary={core} accountsEnabled panelKey={panelKey} panelExpanded={panelExpanded}
          onCollapseSide={side => {
            if (side === -1) ingressPanel.set(undefined); else agentPanel.set(undefined);
            if (selectedDevice.detail && (side === -1) === (selectedDevice.side === 'member')) deviceView.set({ side: selectedDevice.side });
          }}
          onMarkRead={markActivitiesRead} onReorderNodes={reorderNodes} tasks={homepageTasks} onAddAgent={() => setAgentsOpen(true)} left={topologyLeft} right={topologyRight}
          brand={<Hub
            remote={{ unhealthy: remoteFailed, label: t(remoteFailed ? "hub.remoteUnavailable" : "hub.remoteHealthy"),
              open: openConnections, recover: remoteFailed && !readOnlyBrowser ? () => setRecovery("remote") : undefined }}
            core={{ unhealthy: coreState !== "ready", recovery: coreState !== "ready", label: t(coreState === "ready" ? "hub.coreHealthy" : coreState === "stopped" ? "hub.coreStopped" : "hub.coreUnavailable"),
              busy: stopping, action: readOnlyBrowser || !hubHealth ? undefined : coreState !== "ready" ? () => setRecovery("core") : () => void stopCore() }}
            sourceEmpty={!sourceViews.length} agentEmpty={!agents.length}
            onAddSource={() => openOnboarding("product")}
            onManageAgents={() => setAgentsOpen(true)} />} /></div>}
        {devicesEnabled && <><DeviceNodePanel onPanelFrame={panelFrame} /><RemoteTaskPanel tasks={homepageTasks} /></>}
        <PanelRoute value={selectedAgent ? selection : undefined} identity={agentPanelId}>{(snapshot, active) => {
          const agent = inventory.items.find(item => item.agent === snapshot.agent);
          return agent && <AgentPanel selection={snapshot} active={active} agent={agent} expanded={panelExpanded} onToggleWidth={() => setPanelExpanded(value => !value)}
            onSettings={() => setDisplaySettingsOpen(agent.agent)} onPanelFrame={panelFrame} />;
        }}</PanelRoute>
        <PanelRoute value={sourceSelection} identity={sourcePanelId}>{snapshot =>
          <IngressPanel onPanelFrame={panelFrame} selection={snapshot} expanded={panelExpanded} onToggleWidth={() => setPanelExpanded(value => !value)} />
        }</PanelRoute>

        {error && coreState === "ready" && (
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
      {recovery && visible && <HubRecovery key={recovery} side={recovery} onClose={() => setRecovery(undefined)} openCore={() => setRecovery("core")} />}
      {nav.connectionsOpen && visible && !flow && !switching && <ConnectionsPanel />}
      {!readOnlyBrowser && switching && visible && <ChangeConnection />}
      {agentsOpen && <AgentsSettings onClose={() => setAgentsOpen(false)} />}
      {displaySettingsOpen && <AgentDisplaySettings agent={displaySettingsOpen} onClose={() => setDisplaySettingsOpen(false)} />}
    </div>
  );
}

import { maxVisibleAgents } from "../subscriptions/displayPreferences";
import { subscriptions } from "../state/subscriptions";
import { navigation } from "../state/navigation";
import { AgentQuotaIcon } from "../subscriptions/QuotaRing";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  useId,
  type CSSProperties,
} from "react";
import { motion, Reorder } from "motion/react";
import { Plus, Power, Ellipsis, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { api } from "../api";
import { ingressState, connector, run, refreshConnector, orderedSources, reorderSources } from "../state/connector";
import {
  agents as agentStore,
  orderedAgents,
  moveAgent,
  reorderAgents,
  name,
  type Agent,
} from "../state/agents";
import type { Ingress } from "../state/types";
import SourceIcon from "./SourceIcon";
import GraphNode from "./GraphNode";
import ConnectionWires, { type ConnectionWiresHandle, type WireState } from "./ConnectionWires";
import IngressDialog from "./IngressDialog";
import SetupDialog from "./SetupDialog";
import { useSetup, type SetupGoal } from "../state/setup";
import IngressDetailsDialog from "./IngressDetailsDialog";
import AgentsSettings, { AgentDetails } from "./AgentsSettings";
import { Button, Icon, Notice } from "./ui";
import themedMark from "../assets/arc/mark-theme.svg?raw";
function wireState(state: string): WireState {
  if (["connected", "agentAvailable"].includes(state)) return "normal";
  if (["connectingLabel", "preparing"].includes(state)) return "connecting";
  if (["connectionError", "unknown"].includes(state)) return "error";
  return "inactive";
}
export default function ConnectionOverview({ visible = true }: { visible?: boolean }) {
  const gradientId = useId();
  const { status, busy, loading, error } = connector.use();
  agentStore.use();
  const max = maxVisibleAgents.use();
  const { snapshot } = subscriptions.use(), nav = navigation.use();
  const [setupMode, setSetupMode] = useState<"entry" | "progress" | null>(null);
  const [setupGoal, setSetupGoal] = useState<SetupGoal>();
  const [initialSource, setInitialSource] = useState<string>();
  const [manualSetup, setManualSetup] = useState(false);
  const [focusField, setFocusField] = useState<string>();
  const [editing, setEditing] = useState<Ingress>(),
    [formOpen, setFormOpen] = useState(false),
    [details, setDetails] = useState<Ingress>(),
    [autoConnect, setAutoConnect] = useState(false),
    [agentsOpen, setAgentsOpen] = useState(false),
    [detailAgent, setDetailAgent] = useState<Agent>();
  const setup = useSetup(visible && !formOpen && !details && !agentsOpen && !detailAgent);
  const initialSetupShown = useRef(false);
  useEffect(() => {
    if (!visible || initialSetupShown.current || !status || loading || error || !setup.snapshot) return;
    initialSetupShown.current = true;
    if (setup.snapshot.hasState && !setup.snapshot.complete) setSetupMode("progress");
    else if (!setup.snapshot.hasState && !status.ingresses.length) setSetupMode("entry");
  }, [visible, status, loading, error, setup.snapshot]);
  const sources = orderedSources();
  const agents = orderedAgents()
    .filter((a) => a.installed)
    .slice(0, [4, 6, 8, 10].includes(max) ? max : 4);
  const running = sources.some((i) => i.running),
    progressing =
      !!busy || sources.some((i) => ["starting", "stopping"].includes(i.state));
  function edit(ingress?: Ingress, field?: string) {
    setFocusField(field);
    setInitialSource(undefined);
    setManualSetup(false);
    setEditing(ingress);
    setFormOpen(true);
  }
  useEffect(() => {
    if (!nav.ingressEdit) return;
    const ingress = status?.ingresses.find((i) => i.id === nav.ingressEdit?.id);
    if (!ingress) return;
    edit(ingress, nav.ingressEdit.field);
    navigation.set((old) => ({ ...old, ingressEdit: undefined }));
  }, [nav.ingressEdit, status?.ingresses]);
  async function toggle() {
    if (busy) return;
    if (
      !running &&
      (!sources.length || sources.every((i) => !i.config.configured))
    ) {
      edit(sources[0]);
      return;
    }
    await run("ingress-all", async () => {
      const result = await api<{
        results: {
          id: string;
          ok: boolean;
          error?: string;
        }[];
      }>(`ingress/${running ? "stop-all" : "start-all"}`, "POST");
      await refreshConnector();
      const errors = result.results.filter((r) => !r.ok);
      if (errors.length)
        throw new Error(
          errors
            .map(
              (r) =>
                `${sources.find((i) => i.id === r.id)?.name || r.id}: ${r.error}`,
            )
            .join("\n"),
        );
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
    if (!provider) return;
    const agent = orderedAgents().find((a) => a.agent === provider.agentId) || {
      agent: provider.agentId,
      displayName: provider.name,
    };
    setDetailAgent(agent);
    navigation.set((old) => ({ ...old, providerId: undefined }));
  }, [nav.providerId, snapshot]);
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
  const core = useRef<HTMLElement>(null),
    leftWires = useRef<ConnectionWiresHandle>(null),
    rightWires = useRef<ConnectionWiresHandle>(null);
  const sourceNodes = useRef(new Map<string, HTMLButtonElement>());
  const agentNodes = useRef(new Map<string, HTMLButtonElement>());
  const followWires = useCallback(() => {
    leftWires.current?.follow();
    rightWires.current?.follow();
  }, []);
  const [dimensions, setDimensions] = useState({
      width: 1000,
      height: 650,
      left: 200,
      right: 200,
    });
  useLayoutEffect(() => {
    const measure = () =>
      setDimensions({
        width: core.current?.clientWidth || 1000,
        height: core.current?.clientHeight || 650,
        left: leftWires.current?.element?.clientWidth || 1,
        right: rightWires.current?.element?.clientWidth || 1,
      });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    [core.current, leftWires.current?.element, rightWires.current?.element].forEach(
      (el) => el && observer.observe(el),
    );
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const rows = Math.max(Math.max(1, sources.length) + 1, agents.length + 1);
  // Below the 70px compact row size, scroll instead of shrinking names or
  // the 24px minimum Agent icon; reserve room for the last utility row.
  const height = Math.max(320, dimensions.height - 180, rows * 70 + 64),
    leftWidth = dimensions.left,
    rightWidth = dimensions.right;
  const ringRadius = Math.max(
    dimensions.width < 600 ? 48 : 80,
    Math.min(130, dimensions.width * 0.13, dimensions.height * 0.2),
  );
  const brandSize = ringRadius * (240 / 130);
  const coreColumnWidth = brandSize;
  // Real nodes stay centered; the utility occupies the next row, with 16px
  // below the button. Each row reserves 58px: button radius + name gap,
  // name line height + 24px clearance. Its remaining space is the icon radius.
  const rowStep = (count: number) =>
    Math.max(
    70, Math.min(84, (dimensions.height - 64) / Math.max(1, count + 1)),
  );
  const nodeStyle = (count: number) =>
    ({
      "--graph-row-step": `${rowStep(count)}px`,
      "--graph-node-scale": Math.min(1, (rowStep(count) - 58) / 24),
    }) as CSSProperties;
  const [switchOn, setSwitchOn] = useState<boolean>();
  useEffect(() => { if (!progressing && status) setSwitchOn(running); }, [running, progressing, status]);
  function moveSource(id: string, by: number) {
    const ids = sources.map(source => source.id);
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
  return (
    <>
      <motion.section
        ref={core}
        layoutScroll
        onScrollCapture={followWires}
        className={`connection-core ${"brand-mode"}`}
        style={
          {
            "--graph-ring-radius": `${ringRadius}px`,
            "--graph-core-width": `${coreColumnWidth}px`,
            "--graph-brand-size": `${brandSize}px`,
          } as CSSProperties
        }
        aria-label={t("connectionStatus")}
      >
        <div className="core-toggle">
          <button
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
          </button>
        </div>
        <div className="connection-graph" style={{ height }}>
          <Reorder.Group
            as="div"
            axis="y"
            className="graph-nodes sources"
            data-empty={!sources.length}
            style={nodeStyle(sources.length)}
            values={sources.map(source => source.id)}
            onReorder={reorderSources}
          >
            {sources.map(source => (
              <GraphNode key={source.id} id={source.id}
                label={`${source.name}: ${t(sourceState(source))}`}
                state={wireState(sourceState(source))} nodes={sourceNodes.current}
                onMove={by => moveSource(source.id, by)} onMotion={followWires}
                onOpen={() => { setAutoConnect(false); setDetails(source); }}>
                <SourceIcon platform={source.controlSource} panelVisual />
                <span className="graph-node-name">{source.name}</span>
              </GraphNode>
            ))}
            <button
              data-panel-anchor
              className="graph-node add-source"
              aria-label={t("addControlSource")}
              onClick={() => {
                if (!sources.length) { setSetupGoal(undefined); setSetupMode("entry"); }
                else edit();
              }}
            >
              <span className="source-icon" data-panel-visual>
                <Icon icon={Plus} />
              </span>
            </button>
          </Reorder.Group>
          <ConnectionWires ref={leftWires} nodes={sourceNodes.current}
            entries={sources.map(source => ({ id: source.id, state: wireState(sourceState(source)) }))}
            width={leftWidth} height={height} brandSize={brandSize} coreColumnWidth={coreColumnWidth} />
          <div className="graph-brain">
            <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control"
                dangerouslySetInnerHTML={{ __html: themedMark.replace(/^<svg[^>]*>|<\/svg>$/g, "").replaceAll("agent-theme", `${gradientId}-mark`) }} />
          </div>
          <div className="agent-side" style={nodeStyle(agents.length)}>
            <ConnectionWires ref={rightWires} nodes={agentNodes.current} right
              entries={agents.map(agent => ({ id: agent.agent, state: wireState(agentState(agent)) }))}
              width={rightWidth} height={height} brandSize={brandSize} coreColumnWidth={coreColumnWidth} />
            <Reorder.Group as="div" axis="y" className="graph-nodes agents" data-empty={!agents.length}
              values={agents.filter(agent => agent.enabled).map(agent => agent.agent)} onReorder={reorderAgents}>
              {agents.map(agent => (
                <GraphNode key={agent.agent} id={agent.agent}
                  label={`${name(agent)}: ${t(agentState(agent))}`}
                  state={wireState(agentState(agent))} nodes={agentNodes.current}
                  onMove={agent.enabled ? by => moveVisibleAgent(agent.agent, by) : undefined}
                  onMotion={followWires} onOpen={() => setDetailAgent(agent)}>
                  <AgentQuotaIcon agent={agent.agent} />
                  <span className="graph-node-name">{name(agent)}</span>
                </GraphNode>
              ))}
              <button
                data-panel-anchor
                className="graph-node agents-more"
                aria-label={t("manageAgents")}
                onClick={() => setAgentsOpen(true)}
              >
                <Icon icon={Ellipsis} size={20} />
              </button>
            </Reorder.Group>
          </div>
        </div>
        {setup.snapshot?.goal && !setup.snapshot.complete && <div className="setup-resume"><Button onClick={() => setSetupMode("progress")}>{t("setup.resume")}</Button></div>}
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
      </motion.section>
      {setupMode && visible && <SetupDialog mode={setupMode} setMode={setSetupMode} fixedGoal={setupGoal} snapshot={setup.snapshot} error={setup.error} refresh={setup.refresh}
        onClose={() => { setSetupMode(null); if (setup.snapshot?.complete) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".add-source")?.focus()); }} onManual={() => {
          setSetupMode(null);
          edit();
          setManualSetup(true);
          setInitialSource(setupGoal === "claude-loop" ? "claude" : setupGoal === "chatgpt-chat" ? "chatgpt" : undefined);
        }} />}
      {formOpen && (
        <IngressDialog
          key={`${editing?.id ?? "new"}:${focusField ?? ""}`}
          ingress={editing}
          focusField={focusField}
          initialSource={initialSource}
          onGuided={manualSetup ? undefined : source => {
            const goal = source === "claude" ? "claude-loop" : source === "chatgpt" ? "chatgpt-chat" : undefined;
            if (!goal) return false;
            setSetupGoal(goal);
            setFormOpen(false);
            setSetupMode("entry");
            return true;
          }}
          onClose={() => setFormOpen(false)}
          onRemoved={() => { setFormOpen(false); setDetails(undefined); }}
          onSaved={(ingress) => {
            setFormOpen(false);
            if (setupMode) { void setup.refresh(); return; }
            setAutoConnect(true);
            setDetails(ingress);
          }}
        />
      )}
      {details && (
        <IngressDetailsDialog
          ingress={details}
          autoConnect={autoConnect}
          onClose={() => setDetails(undefined)}
          onEdit={(ingress) => {
            edit(ingress);
          }}
        />
      )}
      {agentsOpen && <AgentsSettings onClose={() => setAgentsOpen(false)} />}{" "}
      {detailAgent && (
        <AgentDetails
          agent={detailAgent}
          onClose={() => setDetailAgent(undefined)}
        />
      )}
    </>
  );
}

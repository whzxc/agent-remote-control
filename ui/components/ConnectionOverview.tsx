import {
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  type CSSProperties,
} from "react";
import {
  Plus,
  Power,
  Ellipsis,
  LoaderCircle,
  CircleCheck,
  CircleDashed,
  CircleAlert,
  CirclePause,
} from "lucide-react";
import { t } from "../i18n";
import { api } from "../api";
import { ingressState, connector, run, refreshConnector } from "../state/connector";
import {
  agents as agentStore,
  orderedAgents,
  name,
  type Agent,
} from "../state/agents";
import { subscriptions } from "../state/subscriptions";
import { navigation } from "../state/navigation";
import { maxVisibleAgents } from "../subscriptions/displayPreferences";
import type { Ingress } from "../state/types";
import SourceIcon from "./SourceIcon";
import IngressDialog from "./IngressDialog";
import IngressDetailsDialog from "./IngressDetailsDialog";
import AgentsSettings, { AgentDetails } from "./AgentsSettings";
import { AgentQuotaIcon } from "../subscriptions/QuotaRing";
import { Button, Icon, Notice, Tooltip } from "./ui";
import PlayfulMascot, { type MascotState } from "./PlayfulMascot";
import { mascotPreference } from "../state/store";
import { dark } from "../theme";
import mark from "../assets/arc/mark.svg";
import markDark from "../assets/arc/mark-dark.svg";
export default function ConnectionOverview() {
  const { status, busy, loading, error } = connector.use();
  const inventory = agentStore.use();
  const showMascot = mascotPreference.use(), isDark = dark.use();
  const { snapshot } = subscriptions.use(),
    max = maxVisibleAgents.use(),
    nav = navigation.use();
  const [editing, setEditing] = useState<Ingress>(),
    [formOpen, setFormOpen] = useState(false),
    [details, setDetails] = useState<Ingress>(),
    [autoConnect, setAutoConnect] = useState(false),
    [agentsOpen, setAgentsOpen] = useState(false),
    [detailAgent, setDetailAgent] = useState<Agent>();
  const sources = [...(status?.ingresses || [])].sort(
    (a, b) =>
      Number(b.controlSource === "chatgpt") -
        Number(a.controlSource === "chatgpt") || a.name.localeCompare(b.name),
  );
  const providerOrder =
    snapshot?.providers
      .filter((p) => p.eligible && p.selected)
      .map((p) => p.agentId) || [];
  const agents = orderedAgents()
    .filter((a) => a.installed && a.enabled)
    .sort((a, b) => {
      const ai = providerOrder.indexOf(a.agent),
        bi = providerOrder.indexOf(b.agent);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    })
    .slice(0, [4, 6, 8, 10].includes(max) ? max : 4);
  const running = sources.some((i) => i.running),
    progressing =
      !!busy || sources.some((i) => ["starting", "stopping"].includes(i.state));
  function edit(ingress?: Ingress) {
    setEditing(ingress);
    setFormOpen(true);
  }
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
        results: { id: string; ok: boolean; error?: string }[];
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
      installed: provider.eligible,
    };
    setDetailAgent(agent);
    navigation.set((old) => ({ ...old, providerId: undefined }));
  }, [nav.providerId, snapshot]);
  function agentState(a: Agent) {
    if (a.agent === "codex") {
      const state =
        status?.autoOpenCodex === false
          ? status?.core.appServer.state
          : status?.core.desktop?.state;
      if (state === "ready") return "connected";
      if (state === "error") return "connectionError";
      if (state === "connecting") return "preparing";
    }
    return a.status === "ready"
      ? "connected"
      : a.installed && a.available
        ? "agentAvailable"
        : "connectionError";
  }
  function sourceState(i: Ingress) {
    return error ? "unknown" : ingressState(i);
  }

  const core = useRef<HTMLElement>(null),
    leftWires = useRef<HTMLDivElement>(null),
    rightWires = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({
      width: 1000,
      height: 650,
      left: 200,
      right: 200,
    }),
    [ringOffset, setRingOffset] = useState({ x: 0, y: 0 }),
    [activeTip, setActiveTip] = useState("");
  useLayoutEffect(() => {
    const measure = () =>
      setDimensions({
        width: core.current?.clientWidth || 1000,
        height: core.current?.clientHeight || 650,
        left: leftWires.current?.clientWidth || 1,
        right: rightWires.current?.clientWidth || 1,
      });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    [core.current, leftWires.current, rightWires.current].forEach(
      (el) => el && observer.observe(el),
    );
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const height = Math.max(
      320,
      Math.max(Math.max(1, sources.length) + 1, agents.length + 1) * 84,
    ),
    leftWidth = dimensions.left,
    rightWidth = dimensions.right;
  const ringRadius = Math.max(
    dimensions.width < 600 ? 48 : 80,
    Math.min(130, dimensions.width * 0.13, dimensions.height * 0.2),
  );
  const coreColumnWidth =
    dimensions.width < 600 ? ringRadius * 1.15 : 124 + (ringRadius - 80) * 1.32;
  const y = (index: number, count: number) =>
    height / 2 + (index - (count - 1) / 2) * 84;
  const enabled = sources.filter((s) => s.enabled);
  const mascotState: MascotState = error
    ? "unavailable"
    : !status
      ? "connecting"
      : busy === "ingress-all"
        ? running
          ? "stopping"
          : "connecting"
        : enabled.some((s) => s.state === "stopping")
          ? "stopping"
          : enabled.some((s) => s.state === "starting")
            ? "connecting"
            : enabled.some((s) => ["error", "degraded"].includes(s.state))
              ? running
                ? "degraded"
                : "error"
              : !running
                ? "offline"
                : status.core.activeTurns > 0 || status.core.activeWrites > 0
                  ? "working"
                  : "connected";
  const [switchOn, setSwitchOn] = useState<boolean>();
  useEffect(() => { if (!progressing && status) setSwitchOn(running); }, [running, progressing, status]);
  function stateIcon(label: string) {
    return label === "connectionError"
      ? CircleAlert
      : label === "disabled"
        ? CirclePause
        : ["connectingLabel", "preparing"].includes(label)
          ? LoaderCircle
          : ["connected", "agentAvailable"].includes(label)
            ? CircleCheck
            : CircleDashed;
  }
  const wireWidth = (right: boolean) =>
    Math.max(1, right ? rightWidth : leftWidth);
  // Distribute individual ports along the central ring, including utility branches.
  function port(index: number, count: number, right = false) {
    const radius = ringRadius;
    const halfCore = coreColumnWidth / 2;
    const offset =
      count <= 1
        ? 0
        : (index / (count - 1) - 0.5) * Math.min((count - 1) * 24, 96);
    const reach = Math.sqrt(radius * radius - offset * offset) - halfCore;
    return {
      x: (right ? reach : wireWidth(false) - reach) + ringOffset.x,
      y: height / 2 + offset + ringOffset.y,
    };
  }
  function wire(index: number, count: number, right = false) {
    const inner = port(index, count, right);
    const start = right ? inner : { x: 0, y: y(index, count) };
    const end = right ? { x: wireWidth(true), y: y(index, count) } : inner;
    const span = end.x - start.x;
    return { start, end, c1: start.x + span * 0.45, c2: start.x + span * 0.55 };
  }
  function wirePoint(curve: ReturnType<typeof wire>, u: number) {
    const { start, end, c1, c2 } = curve;
    return {
      x:
        (1 - u) ** 3 * start.x +
        3 * (1 - u) ** 2 * u * c1 +
        3 * (1 - u) * u * u * c2 +
        u ** 3 * end.x,
      y: start.y + (end.y - start.y) * (3 * u * u - 2 * u * u * u),
    };
  }
  // The horizontal status positions define a shared circle in graph coordinates.
  function markerParameter(curve: ReturnType<typeof wire>, right: boolean) {
    const rightOrigin = wireWidth(false) + coreColumnWidth;
    const leftAnchor = wirePoint(wire(0, 1), 1 / 3).x;
    const rightAnchor = rightOrigin + wirePoint(wire(0, 1, true), 2 / 3).x;
    const centerX = (leftAnchor + rightAnchor) / 2;
    const radius = (rightAnchor - leftAnchor) / 2;
    let inner = right ? 0 : 1,
      outer = right ? 1 : 0;
    for (let n = 0; n < 30; n++) {
      const u = (inner + outer) / 2;
      const point = wirePoint(curve, u);
      const distance = Math.hypot(
        point.x + (right ? rightOrigin : 0) - centerX,
        point.y - height / 2,
      );
      if (distance < radius) inner = u;
      else outer = u;
    }
    return (inner + outer) / 2;
  }
  function path(index: number, count: number, right = false, gap = false) {
    const curve = wire(index, count, right);
    const { start, end, c1, c2 } = curve;
    const point = (u: number) => wirePoint(curve, u);
    const tangent = (u: number) => ({
      x:
        3 * (1 - u) ** 2 * (c1 - start.x) +
        6 * (1 - u) * u * (c2 - c1) +
        3 * u * u * (end.x - c2),
      y: 6 * u * (1 - u) * (end.y - start.y),
    });
    const segment = (a: number, b: number) => {
      const p = point(a),
        q = point(b),
        da = tangent(a),
        db = tangent(b),
        span = (b - a) / 3;
      return `M ${p.x} ${p.y} C ${p.x + span * da.x} ${p.y + span * da.y}, ${q.x - span * db.x} ${q.y - span * db.y}, ${q.x} ${q.y}`;
    };
    if (!gap) return segment(0, 1);
    // Keep the curve gap centered on the same circle intersection as the icon.
    const center = markerParameter(curve, right),
      marker = point(center);
    const edge = (bound: number) => {
      let near = center,
        far = bound;
      for (let n = 0; n < 20; n++) {
        const u = (near + far) / 2,
          p = point(u);
        if (Math.hypot(p.x - marker.x, p.y - marker.y) < 13) near = u;
        else far = u;
      }
      return far;
    };
    return `${segment(0, edge(0))} ${segment(edge(1), 1)}`;
  }
  const portStyle = (index: number, count: number, right = false) => {
    const point = port(index, count, right);
    return { left: `${point.x}px`, top: `${point.y}px` };
  };
  const markerPoint = (index: number, count: number, right = false) => {
    const curve = wire(index, count, right);
    return wirePoint(curve, markerParameter(curve, right));
  };
  const marker = (index: number, count: number, right = false) => {
    const point = markerPoint(index, count, right);
    return { left: `${point.x}px`, top: `${point.y}px` };
  };

  const wires = (right = false) => {
    const entries = right
      ? agents.map((a) => ({
          id: a.agent,
          label: name(a),
          state: agentState(a),
          open: () => setAgentsOpen(true),
        }))
      : sources.map((i) => ({
          id: i.id,
          label: i.name,
          state: sourceState(i),
          open: () => {
            setAutoConnect(false);
            setDetails(i);
          },
        }));
    const count = Math.max(right ? 0 : 1, entries.length) + 1;
    return (
      <div
        ref={right ? rightWires : leftWires}
        className={`graph-wires ${right ? "right" : "left"}`}
      >
        {right && inventory.loading && !inventory.loaded && (
          <svg
            className="search-wires"
            viewBox="0 0 200 120"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M 0 60 C 90 60, 110 36, 200 36" />
          </svg>
        )}
        <svg
          viewBox={`0 0 ${wireWidth(right)} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {entries.map((entry, index) => (
            <path
              key={entry.id}
              d={path(index, count, right, true)}
              className={`${["connected", "agentAvailable"].includes(entry.state) ? "live" : ""} ${entry.state === "connectionError" ? "failed" : ""} ${activeTip === entry.id ? "hovered" : ""}`}
            />
          ))}
          {!right && !entries.length && <path d={path(0, 2)} />}
          <path
            d={path(count - 1, count, right)}
            className={right ? "more-wire" : "placeholder"}
          />
        </svg>
        {entries.map((entry, index) => {
          const live = ["connected", "agentAvailable"].includes(entry.state),
            failed = entry.state === "connectionError";
          return (
            <span key={entry.id}>
              <span
                className={`wire-port ${live ? "live" : ""} ${failed ? "failed" : ""}`}
                style={portStyle(index, count, right)}
                aria-hidden="true"
              />
              <Tooltip text={t(entry.state)} side={right ? "left" : "right"}>
                <button
                  type="button"
                  data-panel-anchor
                  className={`wire-status ${live ? "live" : ""} ${failed ? "failed" : ""}`}
                  style={marker(index, count, right)}
                  aria-label={`${entry.label}: ${t(entry.state)}`}
                  onClick={entry.open}
                  onMouseEnter={() => setActiveTip(entry.id)}
                  onMouseLeave={() => setActiveTip("")}
                >
                  <Icon
                    icon={stateIcon(entry.state)}
                    className={
                      ["connectingLabel", "preparing"].includes(entry.state)
                        ? "spinning"
                        : ""
                    }
                  />
                </button>
              </Tooltip>
            </span>
          );
        })}
        <span
          className="wire-port utility-port"
          style={portStyle(count - 1, count, right)}
          aria-hidden="true"
        />
      </div>
    );
  };
  return (
    <>
      <section
        ref={core}
        className="connection-core"
        style={
          {
            "--graph-ring-radius": `${ringRadius}px`,
            "--graph-core-width": `${coreColumnWidth}px`,
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
          <div className="graph-nodes sources">
            {!sources.length && (
              <button
                data-panel-anchor
                className="graph-node"
                aria-label="ChatGPT"
                onClick={() => edit()}
              >
                <SourceIcon platform="chatgpt" panelVisual />
                <span className="graph-node-name">ChatGPT</span>
              </button>
            )}
            {sources.map((source) => (
              <div key={source.id} className="graph-node-wrap">
                <button
                  data-panel-anchor
                  className="graph-node"
                  aria-label={source.name}
                  onClick={() => {
                    setAutoConnect(false);
                    setDetails(source);
                  }}
                >
                  <SourceIcon platform={source.controlSource} panelVisual />
                  <span className="graph-node-name">{source.name}</span>
                </button>
              </div>
            ))}
            <button
              data-panel-anchor
              className="graph-node add-source"
              aria-label={t("addControlSource")}
              onClick={() => edit()}
            >
              <span className="source-icon" data-panel-visual>
                <Icon icon={Plus} />
              </span>
            </button>
          </div>
          {wires()}
          <div
            className="graph-brain"
            style={
              {
                "--ring-offset-x": `${ringOffset.x}px`,
                "--ring-offset-y": `${ringOffset.y}px`,
              } as CSSProperties
            }
          >
            {showMascot ? (
              <PlayfulMascot
                state={mascotState}
                onDisplacement={(p) => setRingOffset({ x: p.x / 3, y: p.y / 3 })}
              />
            ) : (
              <img className="graph-brand" src={isDark ? markDark : mark} alt="Agent Remote Control" draggable={false} />
            )}
          </div>
          <div className="agent-side">
            {wires(true)}
            <div className="graph-nodes agents">
              {agents.map((agent) => (
                <Tooltip
                  key={agent.agent}
                  hoverOnly
                  side="left"
                  text={
                    <>
                      {agent.version && (
                        <div className="status-hint">{agent.version}</div>
                      )}
                    </>
                  }
                >
                  <button
                    data-panel-anchor
                    className="graph-node"
                    aria-label={name(agent)}
                    aria-haspopup="dialog"
                    onClick={() => setDetailAgent(agent)}
                  >
                    <AgentQuotaIcon agent={agent.agent} />
                    <span className="graph-node-name">{name(agent)}</span>
                  </button>
                </Tooltip>
              ))}
              <button
                data-panel-anchor
                className="graph-node agents-more"
                aria-label={t("manageAgents")}
                onClick={() => setAgentsOpen(true)}
              >
                <Icon icon={Ellipsis} size={20} />
              </button>
            </div>
          </div>
        </div>
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
      {formOpen && (
        <IngressDialog
          ingress={editing}
          onClose={() => setFormOpen(false)}
          onRemoved={() => { setFormOpen(false); setDetails(undefined); }}
          onSaved={(ingress) => {
            setFormOpen(false);
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

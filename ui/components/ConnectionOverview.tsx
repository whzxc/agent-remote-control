import { maxVisibleAgents } from "../state/quota";
import { AgentQuotaIcon } from "./AgentQuotaIcon";
import {
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  useId,
  type CSSProperties,
} from "react";
import { Plus, Power, Ellipsis, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { api } from "../api";
import { ingressState, connector, run, refreshConnector } from "../state/connector";
import {
  agents as agentStore,
  orderedAgents,
  name,
  type Agent,
} from "../state/agents";
import type { Ingress } from "../state/types";
import SourceIcon from "./SourceIcon";
import IngressDialog from "./IngressDialog";
import IngressDetailsDialog from "./IngressDetailsDialog";
import AgentsSettings, { AgentDetails } from "./AgentsSettings";
import { Button, Icon, Notice, Tooltip } from "./ui";
import themedMark from "../assets/arc/mark-theme.svg?raw";
type Point = {
  x: number;
  y: number;
};
type WireState = "normal" | "connecting" | "error" | "inactive";
function wireState(state: string): WireState {
  if (["connected", "agentAvailable"].includes(state)) return "normal";
  if (["connectingLabel", "preparing"].includes(state)) return "connecting";
  if (["connectionError", "unknown"].includes(state)) return "error";
  return "inactive";
}
// Offset a cubic by arc length, so the root flare has the same physical reach
// for short, long and steep connections. Widths are full widths, not radii.
function grownWire(
  start: Point,
  c1: Point,
  c2: Point,
  end: Point,
  scale: number,
  state: WireState,
) {
  const steps = Math.max(64, Math.ceil((
    Math.hypot(c1.x - start.x, c1.y - start.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(end.x - c2.x, end.y - c2.y)
  ) / Math.max(0.5, scale)));
  let length = 0;
  const samples = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, v = 1 - t;
    const x = v ** 3 * start.x + 3 * v * v * t * c1.x + 3 * v * t * t * c2.x + t ** 3 * end.x;
    const y = v ** 3 * start.y + 3 * v * v * t * c1.y + 3 * v * t * t * c2.y + t ** 3 * end.y;
    const dx = 3 * v * v * (c1.x - start.x) + 6 * v * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x);
    const dy = 3 * v * v * (c1.y - start.y) + 6 * v * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y);
    const speed = Math.hypot(dx, dy) || 1;
    return { x, y, nx: -dy / speed, ny: dx / speed, length: 0 };
  });
  samples.forEach((p, i) => {
    if (i) length += Math.hypot(p.x - samples[i - 1].x, p.y - samples[i - 1].y);
    p.length = length;
  });
  const edges = samples.map((p) => {
    const u = p.length / (length || 1), s = length - p.length;
    const body = state === "connecting" ? 0 : 3 + 3 * u ** 1.6;
    const halfWidth =
      (scale * (body + 12 * Math.max(0, 1 - s / (26 * scale)) ** 2)) / 2;
    return [
      `${p.x + p.nx * halfWidth} ${p.y + p.ny * halfWidth}`,
      `${p.x - p.nx * halfWidth} ${p.y - p.ny * halfWidth}`,
    ];
  });
  const gap = samples.filter((p) => Math.abs(p.length - length * 0.45) <= 7 * scale);
  return {
    outline: `M ${edges.map(([p]) => p).join(" L ")} L ${edges.reverse().map(([, p]) => p).join(" L ")} Z`,
    centerline: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    gap: gap.length ? `M ${gap.map((p) => `${p.x} ${p.y}`).join(" L ")}` : "",
  };
}
export default function ConnectionOverview() {
  const gradientId = useId();
  const { status, busy, loading, error } = connector.use();
  agentStore.use();
  const max = maxVisibleAgents.use();
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
  const agents = orderedAgents()
    .filter((a) => a.installed)
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
    leftWires = useRef<HTMLDivElement>(null),
    rightWires = useRef<HTMLDivElement>(null);
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
  const layoutCount = (count: number) => count;
  const nodeStyle = (count: number) =>
    ({
      "--graph-row-step": `${rowStep(count)}px`,
      "--graph-node-scale": Math.min(1, (rowStep(count) - 58) / 24),
    }) as CSSProperties;
  const y = (index: number, count: number) =>
    height / 2 + (index - (count - 1) / 2) * rowStep(count);
  const [switchOn, setSwitchOn] = useState<boolean>();
  useEffect(() => { if (!progressing && status) setSwitchOn(running); }, [running, progressing, status]);
  const wireWidth = (right: boolean) =>
    Math.max(1, right ? rightWidth : leftWidth);
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
    const count = entries.length;
    {
      // The mark crops its 100-unit design to viewBox 4 4 92 92.
      const scale = brandSize / (92 * 2.6), radius = 130 * scale;
      const center = { x: right ? -coreColumnWidth / 2 : wireWidth(false) + coreColumnWidth / 2, y: height / 2 };
      const connected = entries.map((entry, index) => ({ ...entry, index, appearance: wireState(entry.state) }))
        .filter((entry) => entry.appearance !== "inactive");
      const halfAngle = Math.min(
        40,
        Math.max(26, ((connected.length - 1) * 8) / 2 + 6),
      );
      const spacing = connected.length > 1 ? Math.min(16, (halfAngle * 2 - 12) / (connected.length - 1)) : 0;
      const onArc = (offset: number) => {
        const angle = ((right ? offset : 180 - offset) * Math.PI) / 180;
        return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
      };
      const arcStart = onArc(-halfAngle), arcEnd = onArc(halfAngle);
      const branches = connected.map((entry, index) => {
        const end = onArc((index - (connected.length - 1) / 2) * spacing);
        const start = {
          x: right ? wireWidth(true) + 12 : (-3 * rowStep(count)) / 84,
          y: y(entry.index, count),
        };
        const c1 = { x: start.x + (right ? -100 : 100) * scale, y: start.y };
        const c2 = {
          x: end.x + ((end.x - center.x) * 60) / 130,
          y: end.y + ((end.y - center.y) * 60) / 130,
        };
        const span = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
        return {
          ...entry,
          start,
          end,
          shape: grownWire(start, c1, c2, end, scale, entry.appearance),
          solidStop: Math.min(0.29, (10 * scale) / span),
          flareStop: Math.min(1, (26 * scale) / span),
          gradient: `${gradientId}-${right ? "right" : "left"}-${index}`,
        };
      });
      return (
        <div ref={right ? rightWires : leftWires} className={`graph-wires earmuff-wires ${right ? "right" : "left"}`}>
          <svg
          viewBox={`0 0 ${wireWidth(right)} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
            <defs>
              {branches.map((branch) => (
                <linearGradient key={branch.id} id={branch.gradient} gradientUnits="userSpaceOnUse" data-state={branch.appearance}
                  x1={branch.end.x} y1={branch.end.y} x2={branch.start.x} y2={branch.start.y}>
                  <stop offset="0" stopOpacity="1" />
                  {/* Keep the overlap solid through the arc's outer edge. */}
                  <stop offset={branch.solidStop} stopOpacity="1" />
                  <stop offset={branch.appearance === "connecting" ? branch.flareStop : 0.3} stopOpacity={branch.appearance === "connecting" ? 0 : 0.7} />
                  <stop offset="1" stopOpacity={branch.appearance === "connecting" ? 0 : right ? 0.42 : 0.32} />
                </linearGradient>
              ))}
            </defs>
            {branches.map((branch) => (
              <g key={branch.id} data-state={branch.appearance}>
                {branch.appearance === "connecting" && (
                  <path d={branch.shape.centerline} className="connecting-wire" style={{ strokeWidth: 3 * scale }} />
                )}
                <path d={branch.shape.outline} className="grown-wire" style={{ fill: `url(#${branch.gradient})` }} />
                {branch.appearance === "error" && (
                  <path d={branch.shape.gap} className="wire-break" style={{ strokeWidth: 18 * scale }} />
                )}
              </g>
            ))}
            <path className="earmuff" style={{ strokeWidth: 14 * scale }}
              d={`M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 ${right ? 1 : 0} ${arcEnd.x} ${arcEnd.y}`} />
          </svg>
        </div>
      );
    }
  };
  return (
    <>
      <section
        ref={core}
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
          <div
            className="graph-nodes sources"
            data-empty={!sources.length}
            style={nodeStyle(layoutCount(sources.length))}
          >
            {sources.map((source) => (
              <div key={source.id} className="graph-node-wrap">
                <Tooltip text={t(sourceState(source))} side="right">
                  <button
                    data-panel-anchor
                    className="graph-node"
                    data-connection-state={wireState(sourceState(source))}
                    aria-label={`${source.name}: ${t(sourceState(source))}`}
                    onClick={() => {
                      setAutoConnect(false);
                      setDetails(source);
                    }}
                  >
                    <SourceIcon platform={source.controlSource} panelVisual />
                    <span className="graph-node-name">{source.name}</span>
                  </button>
                </Tooltip>
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
          <div className="graph-brain">
            <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control"
                dangerouslySetInnerHTML={{ __html: themedMark.replace(/^<svg[^>]*>|<\/svg>$/g, "").replaceAll("agent-theme", `${gradientId}-mark`) }} />
          </div>
          <div className="agent-side" style={nodeStyle(layoutCount(agents.length))}>
            {wires(true)}
            <div className="graph-nodes agents" data-empty={!agents.length}>
              {agents.map((agent) => (
                <Tooltip
                  key={agent.agent}
                  hoverOnly
                  side="left"
                  text={
                    <>
                      {<div>{t(agentState(agent))}</div>}
                      {agent.version && (
                        <div className="status-hint">{agent.version}</div>
                      )}
                    </>
                  }
                >
                  <button
                    data-panel-anchor
                    className="graph-node"
                    data-connection-state={wireState(agentState(agent))}
                    aria-label={`${name(agent)}: ${t(agentState(agent))}`}
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

import { useId, type CSSProperties, type ReactNode } from "react";
import { Brain, Terminal, Pencil, Wrench, MessageSquare, ShieldAlert, CirclePause, Circle, AlertCircle, Check, Zap } from "lucide-react";
import type { AgentPhase, DispatchSummary } from "../../types";
import { useDispatchCatalog } from "../../state/dispatchCatalog";
import { dispatchSpecLabel } from "../composites/dispatchSpecLabel";
import { controlSource } from "../../controlSources";
import { locale, t } from "../../i18n";
import SourceIcon from "../SourceIcon";
import { Icon } from "../ui";
import "./activity.css";

export function PhaseTile({ phase, running = false, completed = false, paused = false, animated = true, source, outcome }: {
  phase: AgentPhase; running?: boolean; completed?: boolean; paused?: boolean; animated?: boolean; source?: DispatchSummary["controlSource"]; outcome?: "unknown" | "failed";
}) {
  const mask = useId();
  const drawing = animated && (completed || (running && phase === "file"));
  return <span className="phase-tile" style={drawing ? { "--phase-mask": `url(#${mask})` } as CSSProperties : undefined} data-phase={outcome ?? (paused ? "interrupted" : completed ? "completed" : phase)}
    data-running={running || undefined} data-animated={animated || undefined} aria-hidden="true">
    {running && <span className="phase-orbit" />}
    {drawing && <svg className="phase-mask" width="0" height="0"><defs>
      <mask id={mask} maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox" x="0" y="0" width="1" height="1">
        <rect className="phase-stroke-reveal" width="1" height="1" fill="white" />
      </mask>
    </defs></svg>}
    <Icon icon={outcome === "unknown" ? Circle : outcome === "failed" ? AlertCircle : paused ? CirclePause : completed ? Check : { thinking: Brain, command: Terminal, file: Pencil, tool: Wrench,
      text: MessageSquare, interaction: ShieldAlert, idle: Circle }[phase]} />
    {source && <SourceBadge source={source} />}
  </span>;
}
export function dispatchSourceLabel(source?: DispatchSummary["controlSource"]) {
  return source?.label || (source?.kind === "local-cli" ? t("localCli") : controlSource(source?.kind ?? "")?.displayName || source?.kind || source?.id || "");
}
export function SourceBadge({ source }: { source: NonNullable<DispatchSummary["controlSource"]> }) {
  return <span className="activity-source-badge" title={dispatchSourceLabel(source)}>
    {source.kind === "local-cli" ? <Icon icon={Terminal} /> : <SourceIcon platform={source.kind ?? ""} />}
  </span>;
}
export function SpecPill({ summary, agent = "", taskId }: { summary?: DispatchSummary; agent?: string; taskId?: string }) {
  locale.use();
  const catalog = useDispatchCatalog(agent, taskId, !!agent && !!summary?.model)?.catalog;
  const label = dispatchSpecLabel(summary, catalog, t);
  const fast = summary?.serviceTier === "priority" || summary?.serviceTier === "fast";
  const text = dispatchSpecLabel(fast ? { ...summary, serviceTier: undefined } : summary, catalog, t);
  if (!label) return null;
  return <span className="activity-spec" title={label}>
    {text && <span>{text}</span>}
    {fast && <span role="img" aria-label={t("activity.fast")}><Icon icon={Zap} /></span>}
  </span>;
}
export function PhaseLabel({ phase, running = false, completed = false, children }: {
  phase: AgentPhase; running?: boolean; completed?: boolean; children: ReactNode;
}) {
  return <span className="phase-label" data-phase={completed ? "completed" : phase} data-running={running || undefined}>{children}
    {running && <span className="phase-shimmer" aria-hidden="true"><span>{children}</span></span>}
  </span>;
}
export function StepTrail({ steps = [], running = false }: {
  steps?: Exclude<AgentPhase, "idle">[]; running?: boolean;
}) {
  return <span className="step-trail" data-running={running || undefined} aria-hidden="true">
    {steps.slice(-5).map((phase, index) => <i key={index} data-phase={phase} />)}
  </span>;
}

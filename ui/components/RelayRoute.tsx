import type { DispatchSummary } from "../types";
import { name, icons, orderedAgents } from "../state/agents";
import { t } from "../i18n";
import { ArrowRight } from "lucide-react";
import { BrandMark, Icon, Tooltip } from "./ui";
import { SourceBadge, dispatchSourceLabel } from "./activity";

export default function RelayRoute({ source, callerAgent, agent, reverse = false, label, time, tone, marksOnly = false }: {
  source?: DispatchSummary["controlSource"]; callerAgent?: string; agent: string; reverse?: boolean; label?: string; time?: string;
  tone?: "warning" | "danger" | "success"; marksOnly?: boolean;
}) {
  const agentLabel = name(orderedAgents().find(row => row.agent === agent) ?? { agent });
  const executor = (bold: boolean) => <span className="relay-party">{icons[agent] && <BrandMark markup={icons[agent]} size={marksOnly ? 12 : 14} />}{bold ? <strong hidden={marksOnly}>{agentLabel}</strong> : <span hidden={marksOnly}>{agentLabel}</span>}</span>;
  const sourceLabel = callerAgent ? name({ agent: callerAgent }) : dispatchSourceLabel(source);
  const controller = (bold: boolean) => {
    if (!source) return bold ? <strong>{t("relay.controller")}</strong> : <span>{t("relay.controller")}</span>;
    const party = <span className="relay-party">{callerAgent
      ? <BrandMark markup={icons[callerAgent]} size={14} /> : <SourceBadge inline source={source} />}
      {bold ? <strong hidden={marksOnly}>{sourceLabel}</strong> : <span hidden={marksOnly}>{sourceLabel}</span>}
    </span>;
    return callerAgent ? <Tooltip text={`${sourceLabel} · ${t("localCli")}`}>{party}</Tooltip> : party;
  };
  return <span className="relay-route" data-marks-only={marksOnly || undefined} aria-label={marksOnly ? `${sourceLabel ? `${sourceLabel} → ` : ""}${agentLabel}` : undefined}>{reverse ? executor(true) : source ? controller(true) : executor(true)}
    {(source || reverse) && <><Icon icon={ArrowRight} size={marksOnly ? 10 : 11} className="relay-route-arrow" />{reverse ? controller(false) : executor(false)}</>}
    {label && <span className="relay-route-label" data-tone={tone}>{label}</span>}
    {time && <time className="relay-route-time">{time}</time>}
  </span>;
}

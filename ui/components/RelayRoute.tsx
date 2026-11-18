import type { DispatchSummary } from "../types";
import { name, icons, orderedAgents } from "../state/agents";
import { t } from "../i18n";
import { ArrowRight } from "lucide-react";
import { BrandMark, Icon } from "./ui";
import { SourceBadge, dispatchSourceLabel } from "./activity";

export default function RelayRoute({ source, agent, reverse = false, label, time, tone, marksOnly = false }: {
  source?: DispatchSummary["controlSource"]; agent: string; reverse?: boolean; label?: string; time?: string;
  tone?: "warning" | "danger" | "success"; marksOnly?: boolean;
}) {
  const agentLabel = name(orderedAgents().find(row => row.agent === agent) ?? { agent });
  const executor = (bold: boolean) => <span className="relay-party">{icons[agent] && <BrandMark markup={icons[agent]} size={marksOnly ? 12 : 14} />}{bold ? <strong hidden={marksOnly}>{agentLabel}</strong> : <span hidden={marksOnly}>{agentLabel}</span>}</span>;
  const controller = (bold: boolean) => source ? <span className="relay-party"><SourceBadge inline source={source} />{bold ? <strong hidden={marksOnly}>{dispatchSourceLabel(source)}</strong> : <span hidden={marksOnly}>{dispatchSourceLabel(source)}</span>}</span> : bold ? <strong>{t("relay.controller")}</strong> : <span>{t("relay.controller")}</span>;
  return <span className="relay-route" data-marks-only={marksOnly || undefined} aria-label={marksOnly ? `${dispatchSourceLabel(source)} → ${name({ agent })}` : undefined}>{reverse ? executor(true) : source ? controller(true) : executor(true)}
    {(source || reverse) && <><Icon icon={ArrowRight} size={marksOnly ? 10 : 11} className="relay-route-arrow" />{reverse ? controller(false) : executor(false)}</>}
    {label && <span className="relay-route-label" data-tone={tone}>{label}</span>}
    {time && <time className="relay-route-time">{time}</time>}
  </span>;
}

import type { DispatchSummary } from "../types";
import { name, icons, orderedAgents } from "../state/agents";
import { t } from "../i18n";
import { ArrowRight } from "lucide-react";
import { Icon } from "./ui";
import { SourceBadge, dispatchSourceLabel } from "./activity";

export default function RelayRoute({ source, agent, reverse = false, label, marksOnly = false }: {
  source?: DispatchSummary["controlSource"]; agent: string; reverse?: boolean; label?: string; marksOnly?: boolean;
}) {
  const executor = <span className="relay-party">{icons[agent] && <span className="relay-brand" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[agent] }} />}<span hidden={marksOnly}>{name(orderedAgents().find(row => row.agent === agent) ?? { agent })}</span></span>;
  const controller = source ? <span className="relay-party"><SourceBadge inline source={source} /><strong hidden={marksOnly}>{dispatchSourceLabel(source)}</strong></span> : <span>{t("relay.controller")}</span>;
  return <span className="relay-route" aria-label={marksOnly ? `${dispatchSourceLabel(source)} → ${name({ agent })}` : undefined}>{reverse ? executor : source ? controller : executor}
    {(source || reverse) && <><Icon icon={ArrowRight} size={12} />{reverse ? controller : executor}</>}
    {label && <span className="relay-route-label">· {label}</span>}
  </span>;
}

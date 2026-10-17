import { Bot } from "lucide-react";
import { t } from "../i18n";
import { agents, icons } from "../state/agents";
import { activeAgents, quotas } from "../state/quota";
import { Tooltip } from "./ui";
export function AgentQuotaIcon({ agent }: { agent: string }) {
  const reading = quotas.use()[agent];
  const enabled = agents.use().items.some(a => a.agent === agent && a.installed && a.enabled);
  const quota = enabled ? reading : undefined;
  const running = activeAgents.use().includes(agent);
  const label = quota ? `${t("quotaRemaining", { percent: quota.remaining > 0 && quota.remaining < 1 ? "<1" : Math.floor(quota.remaining) })} · ${t("quotaReset", { time: quota.resetsAt ? new Date(quota.resetsAt).toLocaleString() : "—" })}` : undefined;
  const icon = <span className={`agent-quota-icon ${quota ? "has-quota" : ""} ${running ? "running" : ""}`} aria-busy={running} aria-label={label} tabIndex={quota ? 0 : undefined}>
    {quota && <svg className="quota-outline" viewBox="0 0 48 48" aria-hidden="true"><circle className="quota-track" cx="24" cy="24" r="21" /><circle cx="24" cy="24" r="21" pathLength="100" stroke={quota.remaining <= 10 ? "var(--danger)" : quota.remaining <= 25 ? "var(--warning)" : "var(--accent)"} strokeDasharray={`${quota.remaining} 100`} transform="rotate(-90 24 24)" /></svg>}
    {running && <svg className="activity-arc" viewBox="0 0 48 48" role="img" aria-label={t("agentTaskRunning")}><circle cx="24" cy="24" r="16" pathLength="100" strokeDasharray="33 67" /></svg>}
    {icons[agent] ? <span className="agent-logo" dangerouslySetInnerHTML={{ __html: icons[agent] }} aria-hidden="true" /> : <Bot className="agent-logo" aria-hidden="true" />}
  </span>;
  return label ? <Tooltip text={label}>{icon}</Tooltip> : icon;
}

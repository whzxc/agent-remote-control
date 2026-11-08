import { AgentIcon } from "../components/ui/agent-icon";
import { locale, t } from "../i18n";
import { icons } from "../state/agents";
import { useNow } from "../state/hooks";
import { quotaDisplay, quotaLabel, quotaPercent, quotaValue } from "./displayPreferences";
import { agentQuotaWindows, windowLabel } from "./labels";
import { quotaColor } from "./presentation";
import { quotaElapsed } from "./quotaTiming";
import type { ProviderSnapshot, QuotaWindow } from "./types";

export function iconWindows(provider: ProviderSnapshot, now: number, summary: boolean) {
  if (provider.state !== "ready" && provider.state !== "stale") return [];
  const windows = provider.windows.filter(window =>
    Number.isFinite(window.usedPercent) && (!window.resetsAt || Date.parse(window.resetsAt) > now));
  const current = windows.find(window => window.id === provider.displayWindowId) ?? windows[0];
  if (summary) return current ? [current] : [];
  const { short, weekly, monthly } = agentQuotaWindows({ ...provider, windows });
  const middle = weekly ?? (current !== short && !monthly ? current : undefined);
  return [short, middle, monthly].filter((window): window is QuotaWindow => window !== undefined);
}

export function AgentQuotaIcon({ agent, provider, summary = false }: {
  agent: string;
  provider?: ProviderSnapshot;
  summary?: boolean;
}) {
  const now = useNow();
  const display = quotaDisplay.use();
  locale.use();
  const readings = provider ? iconWindows(provider, now, summary).map(window => {
    const elapsed = quotaElapsed(window, provider, now);
    const label = `${windowLabel(window.label)} · ${quotaLabel()} ${quotaPercent(window)}`;
    return {
      id: window.id,
      label: elapsed === undefined ? `${label} · ${t("quotaTimingUnknown")}` : label,
      value: quotaValue(window)!,
      color: quotaColor(window, provider, now),
      elapsed,
    };
  }) : [];
  return <AgentIcon markup={icons[agent]} readings={readings} used={display === "used"} />;
}

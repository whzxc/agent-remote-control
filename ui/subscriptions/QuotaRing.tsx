import { Bot } from "lucide-react";
import { t } from "../i18n";
import { icons } from "../state/agents";
import { subscriptions } from "../state/subscriptions";
import { agentActivity } from "../state/activity";
import { useNow } from "../state/hooks";
import {
  quotaDisplay,
  quotaLabel,
  quotaValue,
  quotaPercent,
} from "./displayPreferences";
import { readingStatus, brandIcon, quotaColor } from "./presentation";
import { isFiveHour, isWeekly, windowLabel } from "./labels";
import { quotaPace } from "./pace";
import { quotaPeriod } from "./quotaTiming";
import type { ProviderSnapshot, QuotaWindow } from "./types";
import type { ProviderAccount } from "../types";
import { accountQuotaProvider } from "./accountQuota";

export function agentQuotaWindows(provider: ProviderSnapshot) {
  const windows = provider.windows.filter(window => Number.isFinite(window.usedPercent));
  const weekly = windows.find(window => window.id === provider.displayWindowId && isWeekly(window.label))
    ?? windows.find(window => isWeekly(window.label));
  const shortWindows = windows.filter(window => {
    const period = quotaPeriod(window, provider);
    return isFiveHour(window.label) || (period !== undefined && period < 7 * 86400000);
  });
  const short = shortWindows.find(window => window.poolId === weekly?.poolId) ?? shortWindows[0];
  return { short, weekly };
}
export function ActivityArc({ attention = false }: { attention?: boolean }) {
  return (
    <svg
      className={`activity-arc ${attention ? "needs-attention" : ""}`}
      viewBox="0 0 48 48"
      role="img"
      aria-label={t(attention ? "activity.needsAttention" : "agentTaskRunning")}
    >
      <circle cx="24" cy="24" r="16" pathLength="100" strokeDasharray="33 67" />
    </svg>
  );
}
function TimeTick({
  provider,
  window,
  center,
  radius,
}: {
  provider: ProviderSnapshot;
  window?: QuotaWindow;
  center: number;
  radius: number;
}) {
  const now = useNow();
  quotaDisplay.use();
  const tick = window ? quotaPace(window, provider, now)?.tick : undefined;
  return tick == null ? null : (
    <line
      className="quota-time-tick"
      x1={center}
      x2={center}
      y1={center - radius - 2}
      y2={center - radius + 2}
      transform={`rotate(${tick * 3.6} ${center} ${center})`}
      aria-hidden="true"
    />
  );
}
export function AgentQuotaIcon({ agent, dual = false, quota }: { agent: string; dual?: boolean; quota?: ProviderAccount["quota"] | null }) {
  const { snapshot } = subscriptions.use();
  const now = useNow();
  quotaDisplay.use();
  const platformProvider = snapshot?.settings.enabled
    ? snapshot.providers.find(
        (p) => p.agentIds.includes(agent) && p.eligible,
      )
    : undefined;
  // Undefined uses the platform subscription; null renders the platform logo alone.
  const provider = quota === undefined ? platformProvider : quota ? accountQuotaProvider(agent, quota) : undefined;
  const windows =
    provider && ["ready", "stale"].includes(provider.state)
      ? provider.windows.filter(
          (w) =>
            Number.isFinite(w.usedPercent) &&
            (!w.resetsAt || Date.parse(w.resetsAt) > now),
        )
      : [];
  const current = windows.find((w) => w.id === provider?.displayWindowId);
  const pair = provider ? agentQuotaWindows({ ...provider, windows }) : { short: undefined, weekly: undefined };
  const rings = dual ? [{ window: pair.weekly ?? (current?.id !== pair.short?.id ? current : undefined), radius: 21 }, { window: pair.short, radius: 16.5 }]
    : [{ window: current, radius: 21 }];
  const label = rings.flatMap(({ window }) => window
    ? [`${windowLabel(window.label)} · ${quotaLabel()} ${quotaPercent(window)}`] : []).join(" · ") || undefined;
  return (
    <span
      className={`agent-quota-icon ${label ? "has-quota" : ""} ${dual ? "dual-quota" : ""}`}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {label && provider && (
        <svg className="quota-outline" viewBox="0 0 48 48" aria-hidden="true">
          {rings.map(({ window, radius }) => window && <g key={window.id}>
            <circle className="quota-track" cx="24" cy="24" r={radius} />
            <circle cx="24" cy="24" r={radius} pathLength="100"
              stroke={readingStatus(window, provider, now).color}
              strokeDasharray={`${quotaValue(window)} 100`} transform="rotate(-90 24 24)" />
            {!dual && <TimeTick provider={provider} window={window} center={24} radius={radius} />}
          </g>)}
        </svg>
      )}
      {icons[agent] ? (
        <span
          className="agent-logo"
          dangerouslySetInnerHTML={{ __html: icons[agent] }}
          aria-hidden="true"
        />
      ) : (
        <Bot className="agent-logo" aria-hidden="true" />
      )}
    </span>
  );
}
export default function QuotaRing({
  provider,
  showPercentage = true,
}: {
  provider: ProviderSnapshot;
  showPercentage?: boolean;
}) {
  const now = useNow();
  quotaDisplay.use();
  const activity = agentActivity.use().snapshot;
  const current = provider.windows.find(
      (w) => w.id === provider.displayWindowId,
    ),
    value = quotaValue(current),
    sessions = provider.agentIds.flatMap(id => activity?.agents[id]?.sessions ?? []),
    running = sessions.length > 0,
    attention = sessions.some(session => session.interaction);
  return (
    <span
      className={`quota-ring ${provider.state === "stale" ? "stale" : ""}`}
      aria-busy={running}
    >
      <span className="quota-dial">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="18" className="track" />
          {value !== undefined && (
            <circle
              cx="18"
              cy="18"
              r="18"
              className="value"
              pathLength="100"
              transform="rotate(-90 18 18)"
              stroke={quotaColor(current, provider, now)}
              strokeDasharray={`${Math.max(0, Math.min(100, (value ?? 0)!))} 100`}
            />
          )}
          <TimeTick
            provider={provider}
            window={current}
            center={18}
            radius={18}
          />
        </svg>
        {running && <ActivityArc attention={attention} />}
        <img src={brandIcon(provider.agentId)} alt="" />
      </span>
      {showPercentage && (
        <span
          className="quota-number"
          aria-label={`${quotaLabel()} ${quotaPercent(current)}`}
        >
          {quotaPercent(current)}
        </span>
      )}
    </span>
  );
}

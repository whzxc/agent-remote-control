import { locale, t } from "../i18n";
import { useNow } from "../state/hooks";
import { quotaDisplay, quotaLabel, quotaPercent, quotaValue, resetDisplay } from "../subscriptions/displayPreferences";
import { agentQuotaWindows, windowLabel } from "../subscriptions/labels";
import { quotaElapsed } from "../subscriptions/quotaTiming";
import { compactReset, preciseTime, quotaColor, usageColors } from "../subscriptions/presentation";
import { quotaPace } from "../subscriptions/pace";
import type { ProviderSnapshot } from "../subscriptions/types";
import { Button } from "./ui";
import UsageHistory from "../subscriptions/UsageHistory";
import ResetCreditDetails from "../subscriptions/ResetCreditDetails";

export default function AgentQuota({ provider, form = "agent" }: { provider: ProviderSnapshot; form?: "agent" | "account" }) {
  const now = useNow();
  locale.use();
  const display = quotaDisplay.use(), reset = resetDisplay.use();
  const { short, weekly, monthly } = agentQuotaWindows(provider);
  const selected = [short, weekly, monthly].filter(window => window !== undefined);
  const windows = selected.length ? selected : provider.windows.filter(window => Number.isFinite(window.usedPercent)).slice(0, 2);
  const pace = windows.map(window => quotaPace(window, provider, now));
  const summaryWindow = weekly ?? windows[0];
  if (!windows.length) return <p className="timeline-meta agent-no-quota">{t("agentPanel.noQuota")}</p>;
  return <section className="agent-quota-block" data-form={form} aria-label={t("agentQuotaGroup")}>
    <div className="agent-quota-cards">
      {windows.map((window, index) => {
        const resetAt = Date.parse(window.resetsAt ?? "");
        const elapsed = quotaElapsed(window, provider, now);
        const tick = elapsed === undefined ? undefined : (display === "remaining" ? 1 - elapsed : elapsed) * 100;
        const label = windowLabel(window.label), value = quotaValue(window);
        const resetText = reset === "time" && Number.isFinite(resetAt) ? preciseTime(window.resetsAt) : compactReset(window.resetsAt, now);
        const barColor = form === "account"
          ? window.usedPercent >= 100 ? "var(--danger)" : pace[index]?.label && !pace[index]?.flame ? "var(--warning)" : usageColors.good
          : pace[index]?.color ?? quotaColor(window, provider, now);
        return <div className="agent-quota-card" key={window.id} data-monthly={window === monthly || undefined}>
          <div className="agent-quota-window"><span title={window.scope}>{label}</span>
            <time dateTime={Number.isFinite(resetAt) ? window.resetsAt : undefined}
              title={Number.isFinite(resetAt) ? t("quotaResetAt", { time: preciseTime(window.resetsAt) }) : t("quotaResetUnknown")}
              aria-label={t(reset === "time" ? "quotaResetAt" : "quotaResetIn", { time: resetText })}>{resetText}</time>
          </div>
          <div className="agent-quota-balance">
            <strong className="agent-quota-percent" aria-label={`${label} · ${quotaLabel()} ${quotaPercent(window)}`}>{quotaPercent(window)}</strong>
            {pace[index]?.label && <span className="agent-quota-warning" title={pace[index]?.tooltip}>{pace[index]?.label}</span>}
            {window === summaryWindow && (Number.isFinite(provider.creditBalance) || provider.availableResetCount != null) && <div className="agent-quota-extras">
              {Number.isFinite(provider.creditBalance) && <span>{Math.ceil(provider.creditBalance!)} credits</span>}
              {provider.availableResetCount != null && <UsageHistory detail={() => <ResetCreditDetails credits={provider.resetCredits} now={now} />}>
                {({ register, hover, focus, expanded }) => <Button variant="ghost" className="agent-quota-resets"
                  ref={node => register("resets", node)}
                  onPointerEnter={event => event.pointerType !== "touch" && hover("resets")}
                  onPointerLeave={event => event.pointerType !== "touch" && hover("")}
                  onClick={() => focus("resets")} onFocus={() => focus("resets")} onBlur={() => focus("")}
                  aria-expanded={expanded}>
                  {provider.availableResetCount} {provider.availableResetCount === 1 ? "reset" : "resets"}
                </Button>}
              </UsageHistory>}
            </div>}
          </div>
          <div className="agent-quota-track" role="meter" aria-label={`${label} · ${quotaLabel()}`}
            title={pace[index]?.tooltip}
            aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${value}%`, background: barColor }} />
            {tick !== undefined && <span className="agent-quota-pace-marker" role="img" aria-label={t("quotaTimeTick")}
              title={t("quotaTimeTick")} style={{ left: `clamp(1px, ${tick}%, calc(100% - 1px))` }} />}
          </div>
        </div>;
      })}
    </div>
  </section>;
}

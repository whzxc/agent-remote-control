import { locale, t } from "../i18n";
import { useNow } from "../state/hooks";
import { quotaDisplay, resetDisplay } from "../subscriptions/displayPreferences";
import { agentQuotaWindows } from "../subscriptions/labels";
import type { ProviderSnapshot } from "../subscriptions/types";
import UsageHistory from "../subscriptions/UsageHistory";
import ResetCreditDetails from "../subscriptions/ResetCreditDetails";
import { QuotaCard, QuotaDetailAction } from "./ui/QuotaCard";

export default function AgentQuota({ provider }: { provider: ProviderSnapshot }) {
  const now = useNow();
  locale.use();
  quotaDisplay.use();
  resetDisplay.use();
  const { short, weekly, monthly } = agentQuotaWindows(provider);
  const selected = [short, weekly, monthly].filter(window => window !== undefined);
  const windows = selected.length ? selected : provider.windows.filter(window => Number.isFinite(window.usedPercent)).slice(0, 2);
  const summaryWindow = weekly ?? windows[0];
  if (!windows.length) return <p className="timeline-meta agent-no-quota">{t("agentPanel.noQuota")}</p>;
  return <section className="quota-window-grid" aria-label={t("agentQuotaGroup")}>
    {windows.map(window => <QuotaCard key={window.id} window={window} provider={provider} now={now}
      extra={window === summaryWindow && (Number.isFinite(provider.creditBalance) || provider.availableResetCount != null) &&
        <div className="quota-window-meta">
          {Number.isFinite(provider.creditBalance) && <span>{Math.ceil(provider.creditBalance!)} credits</span>}
          {provider.availableResetCount != null && <UsageHistory detail={() => <ResetCreditDetails credits={provider.resetCredits} now={now} />}>
            {({ register, hover, focus, expanded }) => <QuotaDetailAction ref={node => register("resets", node)}
              onPointerEnter={event => event.pointerType !== "touch" && hover("resets")}
              onPointerLeave={event => event.pointerType !== "touch" && hover("")}
              onClick={() => focus("resets")} onFocus={() => focus("resets")} onBlur={() => focus("")}
              aria-expanded={expanded}>{t("usageResetCountValue", { count: provider.availableResetCount! })}</QuotaDetailAction>}
          </UsageHistory>}
        </div>
      } />)}
  </section>;
}

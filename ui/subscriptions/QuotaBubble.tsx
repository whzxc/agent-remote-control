import { useState } from "react";
import { RefreshCw, TriangleAlert, CircleAlert, Flame } from "lucide-react";
import { t, locale } from "../i18n";
import { openUrl } from "../platform";
import { useNow } from "../state/hooks";
import { refreshSubscription } from "../state/subscriptions";
import { Button, IconButton, Icon, Progress, HoverScope } from "../components/ui";
import {
  quotaDisplay,
  resetDisplay,
  quotaLabel,
  quotaPercent,
  quotaValue,
  usagePeriods,
  usagePeriodLabels,
} from "./displayPreferences";
import { windowLabel, subscriptionLabel } from "./labels";
import {
  brandIcon,
  quotaColor,
  resetText,
  compactReset,
  preciseTime,
  errorLabels,
} from "./presentation";
import { quotaPace } from "./pace";
import { cycleEstimate } from "./cycleEstimate";
import { usageLink } from "./usageLinks";
import type { ProviderSnapshot } from "./types";
import UsageHistory from "./UsageHistory";
import "./bubble.css";
export default function QuotaBubble({
  provider,
  rail = false,
  onPopover,
  detailPlacement = "left",
  onRefresh,
  showHistory = true,
  link = true,
}: {
  provider: ProviderSnapshot;
  rail?: boolean;
  onPopover?: (points: [number, number][]) => void;
  detailPlacement?: "left" | "right" | "bottom";
  onRefresh?: () => Promise<void>;
  showHistory?: boolean;
  link?: boolean;
}) {
  const now = useNow(),
    periods = usagePeriods.use();
  quotaDisplay.use();
  resetDisplay.use();
  const [requesting, setRequesting] = useState(false),
    [error, setError] = useState("");
  const usageUrl = link ? usageLink(provider) : undefined,
    notices: string[] = [];
  if (error) notices.push(error);
  if (provider.error)
    notices.push(
      provider.error.message ||
        t(errorLabels[provider.error.code] || "usageUnavailable"),
    );
  if (
    provider.history?.error &&
    provider.history.error !== "history-unavailable"
  )
    notices.push(provider.history.error);
  if (provider.pinUnavailable) notices.push(t("usagePinUnavailable"));
  if (provider.accountBlocked) notices.push(t("usageAccountBlocked"));
  if (provider.state === "stale") notices.push(t("usageStale"));
  for (const w of provider.windows)
    if (w.exhausted || provider.blockedPoolIds.includes(w.poolId))
      notices.push(`${windowLabel(w.label)}: ${t("usagePoolBlocked")}`);
  const timestamp = Date.parse(provider.observedAt ?? ""),
    age = Number.isFinite(timestamp)
      ? Math.max(0, Math.floor((now - timestamp) / 60000))
      : undefined;
  const ageText = age === undefined ? "" : age < 1 ? t("justNow") :
    new Intl.RelativeTimeFormat(locale.get()).format(-Math.floor(age < 60 ? age : age < 1440 ? age / 60 : age / 1440), age < 60 ? "minute" : age < 1440 ? "hour" : "day");
  async function refresh() {
    setRequesting(true);
    setError("");
    try {
      await (onRefresh ? onRefresh() : refreshSubscription(provider.providerId));
    } catch (e) {
      setError(String(e));
    } finally {
      setRequesting(false);
    }
  }
  const tokens = new Intl.NumberFormat(undefined, {
      notation: "compact",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    dollars = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

  const readings = provider.windows.map((w) => ({
    w,
    pace: quotaPace(w, provider, now),
    estimate: cycleEstimate(w, provider, now),
  }));
  const hasError =
    !!error ||
    !!provider.accountBlocked ||
    (!!provider.error &&
      ![
        "no-subscription",
        "no-limits-reported",
        "unsupported-platform",
      ].includes(provider.error.code)) ||
    (!!provider.history?.error &&
      provider.history.error !== "history-unavailable");
  function detail(key: string) {
    const reading = readings.find((r) => "reading:" + r.w.id === key);
    if (key === "notices")
      return (
        <>
          {notices.map((notice, i) => (
            <div key={i}>{notice}</div>
          ))}
        </>
      );
    if (reading)
      return (
        <>
          {[reading.pace?.tooltip, ...(reading.estimate?.lines ?? [])]
            .filter(Boolean)
            .map((line, i) => (
              <div key={i}>{line}</div>
            ))}
        </>
      );
    if (key === "resets")
      return (
        <>
          {provider.resetCredits?.length
            ? provider.resetCredits.map((credit, index) => (
                <div className="history-period expiry-row" key={index}>
                  <span>
                    <span className="credit-number">{index + 1}</span>
                    {preciseTime(credit.expiresAt) || t("usageExpiryUnknown")}
                  </span>
                  <span>{resetText(credit.expiresAt, now)}</span>
                </div>
              ))
            : t("usageExpiryUnknown")}
        </>
      );
    const row = provider.history?.periods?.find((p) => p.id === key);
    if (!row) return null;
    return (
      <>
        <strong>{t(usagePeriodLabels[row.id])}</strong>
        {row.models?.length
          ? row.models.map((model) => (
              <div className="model-reading" key={model.model}>
                <div className="history-period">
                  <strong>{model.model}</strong>
                  <span className="model-share">
                    {row.tokens
                      ? Math.round((model.tokens / row.tokens) * 100)
                      : 0}
                    %
                  </span>
                </div>
                <Progress
                  label={model.model}
                  value={row.tokens ? (model.tokens / row.tokens) * 100 : 0}
                />
                <div className="history-period model-meta">
                  <span>
                    {model.estimatedUsd == null
                      ? "—"
                      : dollars.format(model.estimatedUsd)}
                  </span>
                  <span title={model.tokens.toLocaleString() + " tokens"}>
                    {tokens.format(model.tokens)} tokens
                  </span>
                </div>
              </div>
            ))
          : "-"}
      </>
    );
  }
  return (
    <div className={`quota-bubble ${rail ? "rail-quota" : "embedded"}`}>
      <UsageHistory
        rail={rail}
        side={detailPlacement}
        detail={detail}
        onBounds={onPopover}
      >
        {({ register, hover, focus, expanded, displayed, highlighted }) => (
          <>
            <header>
              <span
                className="provider-logo"
                style={{
                  maskImage: `url(${JSON.stringify(brandIcon(provider.agentId))})`,
                }}
                aria-hidden="true"
              />
              <span className="subscription-heading">
                {usageUrl ? (
                  <a
                    className="subscription-link"
                    href={usageUrl}
                    draggable={false}
                    onClick={(e) => {
                      e.preventDefault();
                      void openUrl(usageUrl).catch((e) => setError(String(e)));
                    }}
                  >
                    {subscriptionLabel(provider)}
                  </a>
                ) : (
                  <strong>{subscriptionLabel(provider)}</strong>
                )}
                {provider.plan && provider.agentId !== "codex" && (
                  <span className="provider-plan">{provider.plan}</span>
                )}
                {notices.length > 0 && (
                  <span
                    ref={(node) => register("notices", node)}
                    onPointerEnter={(event) => event.pointerType !== "touch" && hover("notices")}
                    onPointerLeave={(event) => event.pointerType !== "touch" && hover("")}
                    onFocus={() => focus("notices")}
                    onBlur={() => focus("")}
                    tabIndex={0}
                    aria-expanded={expanded && displayed === "notices"}
                    className={`subscription-notice ${hasError ? "error" : ""}`}
                    role="img"
                    aria-label={notices.join(" · ")}
                  >
                    <Icon icon={hasError ? CircleAlert : TriangleAlert} />
                  </span>
                )}
              </span>
              <time
                className="refresh-age"
                title={preciseTime(provider.observedAt)}
              >
                {ageText}
              </time>
              <IconButton
                icon={RefreshCw}
                size={16}
                label={t("usageRefresh")}
                busy={requesting || provider.refreshing}
                disabled={!provider.eligible || !provider.selected}
                onClick={() => void refresh()}
              />
            </header>
            {readings.map(({ w, pace, estimate }) => {
              const key = "reading:" + w.id;
              return (
                <div key={w.id} className="bubble-reading">
                  <div className="reading-title">
                    <span>
                      {provider.providerId === "antigravity" && w.scope
                        ? `${w.scope} · `
                        : ""}
                      {windowLabel(w.label)}
                    </span>
                    {estimate && (
                      <span className="quota-estimate" title={estimate.lines.join("\n")}>
                        {t("quotaCycleValue", { amount: estimate.amount })}
                      </span>
                    )}
                    <span className="reading-reset" title={w.resetsAt && Number.isFinite(Date.parse(w.resetsAt)) ? t("quotaResetAt", { time: preciseTime(w.resetsAt) }) : t("quotaResetUnknown")} aria-label={t("quotaResetIn", { time: compactReset(w.resetsAt, now) })}>
                      {compactReset(w.resetsAt, now)}
                    </span>
                  </div>
                  <div
                    title={pace?.tick != null ? t("quotaTimeTick") : undefined}
                    className="reading-track"
                    role="meter"
                    aria-label={`${windowLabel(w.label)} · ${quotaLabel()}`}
                    aria-valuenow={quotaValue(w)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      style={{
                        width: `${quotaValue(w)}%`,
                        background:
                          pace?.color ?? quotaColor(w, provider, now),
                      }}
                    />
                    {pace?.tick != null && (
                      <span
                        className="pace-tick"
                        style={{
                          left: `clamp(1px, ${pace.tick}%, calc(100% - 1px))`,
                        }}
                      />
                    )}
                  </div>
                  <div className="reading-meta">
                    <span>
                      {quotaLabel()} {quotaPercent(w)}
                    </span>
                    <div className="reading-timing">
                      {pace?.label && (
                        <Button
                          variant="ghost"
                          className="pace-warning"
                          ref={(node) => register(key, node)}
                          onPointerEnter={(event) => event.pointerType !== "touch" && hover(key)}
                          onPointerLeave={(event) => event.pointerType !== "touch" && hover("")}
                          onClick={() => focus(key)}
                          onFocus={() => focus(key)}
                          onBlur={() => focus("")}
                          aria-expanded={expanded && displayed === key}
                          aria-label={`${windowLabel(w.label)} · ${pace.label}`}
                        >
                          {pace.flame && <Icon icon={Flame} />} {pace.label}
                        </Button>
                      )}

                    </div>
                  </div>
                </div>
              );
            })}
            <HoverScope className="usage-history" activeKey={highlighted}>
              {(provider.creditBalance ?? 0) > 0 && (
                <div className="history-period">
                  <span>{t("usageCreditBalance")}</span>
                  <span>{new Intl.NumberFormat().format(Math.ceil(provider.creditBalance!))} credits</span>
                </div>
              )}
              {provider.availableResetCount != null && (
                <div className="history-period">
                  <span>{t("usageResetCount")}</span>
                  <Button
                    ref={(node) => {
                      register("resets", node);
                    }}
                    variant="ghost"
                    className="history-toggle"
                    data-hover-target="resets"
                    onPointerEnter={(event) => event.pointerType !== "touch" && hover("resets")}
                    onPointerLeave={(event) => event.pointerType !== "touch" && hover("")}
                    onClick={() => focus("resets")}
                    onFocus={() => focus("resets")}
                    onBlur={() => focus("")}
                    aria-expanded={expanded && displayed === "resets"}
                  >
                    <span>
                      {t("usageResetCountValue", {
                        count: provider.availableResetCount,
                      })}
                    </span>
                  </Button>
                </div>
              )}
              {showHistory && provider.history?.periods
                ?.filter((row) => periods.includes(row.id))
                .map((row) => (
                  <div className="history-period" key={row.id}>
                    <span>{t(usagePeriodLabels[row.id])}</span>
                    <Button
                      variant="ghost"
                      className="history-toggle"
                      data-hover-target={row.id}
                      ref={(node) => {
                        register(row.id, node);
                      }}
                      onPointerEnter={(event) => event.pointerType !== "touch" && hover(row.id)}
                      onPointerLeave={(event) => event.pointerType !== "touch" && hover("")}
                      onFocus={() => focus(row.id)}
                      onBlur={() => focus("")}
                      aria-expanded={expanded && displayed === row.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        focus(row.id);
                      }}
                    >
                      {row.tokens
                        ? `${row.estimatedUsd == null ? "—" : dollars.format(row.estimatedUsd)} · ${tokens.format(row.tokens)} tokens`
                        : "-"}
                    </Button>
                  </div>
                ))}
            </HoverScope>
          </>
        )}
      </UsageHistory>
    </div>
  );
}

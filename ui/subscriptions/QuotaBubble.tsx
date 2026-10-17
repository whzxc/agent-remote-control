import { useState } from "react";
import { RefreshCw, TriangleAlert, CircleAlert, Flame } from "lucide-react";
import { t, locale } from "../i18n";
import { openUrl } from "../platform";
import { useNow } from "../state/hooks";
import { refreshSubscription } from "../state/subscriptions";
import { Button, IconButton, Icon, HoverScope } from "../components/ui";
import {
  quotaDisplay,
  resetDisplay,
  quotaLabel,
  quotaPercent,
  quotaValue,
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
import { usageLink } from "./usageLinks";
import type { ProviderSnapshot } from "./types";
import UsageHistory from "./UsageHistory";
import "./bubble.css";
export default function QuotaBubble({
  provider,
  onRefresh,
  link = true,
}: {
  provider: ProviderSnapshot;
  onRefresh?: () => Promise<void>;
  link?: boolean;
}) {
  const now = useNow();
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
  if (provider.rawUsage?.sharedUsageError) notices.push(t("usageSharedUnavailable"));
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
  const readings = provider.windows.map((w) => ({
    w,
    pace: quotaPace(w, provider, now),
  }));
  const hasError =
    !!error ||
    !!provider.accountBlocked ||
    (!!provider.error &&
      ![
        "no-subscription",
        "no-limits-reported",
        "unsupported-platform",
      ].includes(provider.error.code));
  const productRows = provider.productUsage?.rows ?? [];
  const productRemainder = provider.productUsage?.basis === "allowance"
    ? Math.max(0, 100 - productRows.reduce((sum, row) => sum + row.percent, 0)) : 0;
  function detail(key: string) {
    if (key.startsWith("product:")) {
      const row = productRows[Number(key.slice(8))];
      return row ? `${row.label} · ${new Intl.NumberFormat(locale.get(), {maximumFractionDigits: 1}).format(row.percent)}%` : null;
    }
    if (key === "productRemaining") return `${t("usageRemaining")} · ${new Intl.NumberFormat(locale.get(), {maximumFractionDigits: 1}).format(productRemainder)}%`;

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
          {[reading.pace?.tooltip]
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
                <div key={index}>
                <div className="history-period expiry-row">
                  <span>
                    <span className="credit-number">{credit.count ?? index + 1}</span>
                    {preciseTime(credit.expiresAt) || t("usageExpiryUnknown")}
                  </span>
                  <span>{resetText(credit.expiresAt, now)}</span>
                </div>
                </div>
              ))
            : t("usageExpiryUnknown")}
        </>
      );
    return null;
  }
  return (
    <div className="quota-bubble embedded">
      <UsageHistory
        detail={detail}
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
                disabled={!provider.eligible}
                onClick={() => void refresh()}
              />
            </header>
            {readings.map(({ w, pace }) => {
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
              {!!provider.productUsage?.rows.length && (
                <section className="product-usage" aria-label={t(provider.productUsage.shared ? "usageSharedProducts" : "usageWeeklyProducts")}>
                  <div className="product-usage-title">{t(provider.productUsage.shared ? "usageSharedProducts" : "usageWeeklyProducts")}</div>
                  <div className="product-usage-bar">
                    {productRows.map((row, index) => {
                      const key = `product:${index}`;
                      return <Button
                        key={row.label}
                        variant="ghost"
                        className="product-usage-segment"
                        style={{flexGrow: row.percent, background: `var(--chart-${index % 8 + 1})`}}
                        aria-label={`${row.label} · ${row.percent}%`}
                        ref={node => register(key, node)}
                        onPointerEnter={event => event.pointerType !== "touch" && hover(key)}
                        onPointerLeave={event => event.pointerType !== "touch" && hover("")}
                        onFocus={() => focus(key)} onBlur={() => focus("")}
                        onClick={() => focus(key)}
                        aria-expanded={expanded && displayed === key}
                      />;
                    })}
                    {productRemainder > 0 && <Button
                      variant="ghost" className="product-usage-segment product-usage-remaining"
                      style={{flexGrow:productRemainder}}
                      aria-label={`${t("usageRemaining")} · ${productRemainder}%`}
                      ref={node => register("productRemaining", node)}
                      onPointerEnter={event => event.pointerType !== "touch" && hover("productRemaining")}
                      onPointerLeave={event => event.pointerType !== "touch" && hover("")}
                      onFocus={() => focus("productRemaining")} onBlur={() => focus("")}
                      onClick={() => focus("productRemaining")}
                      aria-expanded={expanded && displayed === "productRemaining"}
                    />}
                  </div>
                </section>
              )}
            </HoverScope>
          </>
        )}
      </UsageHistory>
    </div>
  );
}

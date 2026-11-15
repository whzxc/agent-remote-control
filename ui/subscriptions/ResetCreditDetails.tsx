import { QuotaPeriod, QuotaCredit } from './QuotaDetail';
import { t } from "../i18n";
import { preciseTime, resetText } from "./presentation";
import type { ProviderSnapshot } from "./types";
import "./bubble.css";

export default function ResetCreditDetails({ credits, now }: { credits: ProviderSnapshot["resetCredits"]; now: number }) {
  return credits?.length ? <>{credits.map((credit, index) => <QuotaPeriod key={index} className="history-period expiry-row">
    <span><QuotaCredit className="credit-number">{credit.count ?? index + 1}</QuotaCredit>{preciseTime(credit.expiresAt) || t("usageExpiryUnknown")}</span>
    <span>{resetText(credit.expiresAt, now)}</span>
  </QuotaPeriod>)}</> : <>{t("usageExpiryUnknown")}</>;
}

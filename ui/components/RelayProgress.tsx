import { usePrivacy } from "../state/privacy";
import { maskSensitive } from "../privacyMask";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { copyText } from "../platform";
import type { RelayProgress as Progress } from "../state/relay";
import { Button, Notice, SingleChoice, Tile } from "./ui";
export default function RelayProgress({ progress, busy, account, setAccount, onCancel, onRetry, cancelInFooter = false }: {
  cancelInFooter?: boolean;
  progress: Progress; busy: boolean; account: string; setAccount: (value: string) => void; onCancel: () => void; onRetry: () => void;
}) {
  const hidden = usePrivacy();
  const accountOptions = progress.accounts ?? [];
  const phase = ["login", "deploying", "connecting", "ready"].indexOf(progress.phase);
  const reason = progress.reason ?? "";
  const failure = progress.cancelled ? "cancelled" : progress.accounts?.length ? "chooseAccount"
    : /timed out/i.test(reason) ? "timeout"
    : /invalid.*link|invalid.*origin|shared.*token|invitation/i.test(reason) ? "invalidLink"
    : /account.*unavailable|no cloudflare account/i.test(reason) ? "accountUnavailable"
    : `failure.${progress.failedPhase ?? "connecting"}`;
  return <div className="remote-progress">
    {progress.phase === "failed" ? <>
      <Notice tone="danger">{t(`connect.${failure}`)}</Notice>
      {!!progress.accounts?.length && <SingleChoice label={t("connect.chooseAccount")} value={String(accountOptions.findIndex(option => option.id === account))} onChange={value => setAccount(accountOptions[Number(value)].id)} options={accountOptions.map((a, index) => ({ value: String(index), label: hidden ? maskSensitive(a.name || a.id, true) : a.name || a.id }))} />}
      <Button variant="primary" busy={busy} disabled={!!progress.accounts?.length && !account} onClick={onRetry}>{t("retry")}</Button>
    </> : <ol className="remote-steps">{["login", "deploying", "connecting"].map((step, index) => <li key={step} aria-current={index === phase ? "step" : undefined}>
      <Tile icon={phase > index ? Check : phase === index ? LoaderCircle : Circle} className={phase > index ? "step-complete" : phase === index ? "step-running" : "step-waiting"} /><div><strong>{t(`connect.phase.${step}`)}</strong>{(step === "deploying" || phase === index) && <small>{[phase === index && t("connect.inProgress"), step === "deploying" && t("connect.twentySeconds")].filter(Boolean).join(" · ")}</small>}</div>
    </li>)}</ol>}
    {progress.loginUrl && <Button variant="ghost" onClick={() => void copyText(progress.loginUrl!)}>{t("connect.copyLogin")}</Button>}
    {!cancelInFooter && <div className="remote-progress-actions"><Button disabled={busy} onClick={onCancel}>{t("cancel")}</Button>{progress.phase !== "failed" && <Button variant="primary" busy>{t("connect.inProgress")}</Button>}</div>}
  </div>;
}

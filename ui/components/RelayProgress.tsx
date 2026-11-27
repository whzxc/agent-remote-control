import { t } from "../i18n";
import { copyText } from "../platform";
import { maskSensitive } from "../privacyMask";
import { usePrivacy } from "../state/privacy";
import type { RelayProgress as Progress } from "../state/relay";
import {
  RelayProgressView,
  type RelayProgressStep,
} from "./connectivity/RelayProgressView";
import { useDialogClose } from "./hosting/useDialogClose";
import { Button } from "./kit/button";
import { DialogActions } from "./ui/Dialog";

export default function RelayProgress({
  progress,
  busy,
  account,
  setAccount,
  onCancel,
  onRetry,
  cancelInFooter = false,
}: {
  cancelInFooter?: boolean;
  progress: Progress;
  busy: boolean;
  account: string;
  setAccount: (value: string) => void;
  onCancel?: () => void;
  onRetry: () => void;
}) {
  const hidden = usePrivacy();
  const closeDialog = useDialogClose();
  const accountOptions = progress.accounts ?? [];
  const phase = ["login", "deploying", "connecting", "ready"].indexOf(
    progress.phase,
  );
  const reason = progress.reason ?? "";
  const loginStatus = progress.loginUrl
    ? "waiting"
    : (progress.loginStage ?? "authorizing");
  const failure = progress.cancelled
    ? "cancelled"
    : progress.accounts?.length
      ? "chooseAccount"
      : /callback port is already in use/i.test(reason)
        ? "loginPortInUse"
        : /account.*unavailable|no cloudflare account/i.test(reason)
          ? "accountUnavailable"
          : progress.failedPhase === "login" &&
              progress.loginStage === "preparing"
            ? "toolSetupFailed"
            : progress.failedPhase === "login" &&
                progress.loginStage === "checking"
              ? "accountCheckFailed"
              : /cloudflare login timed out/i.test(reason)
                ? "loginTimedOut"
                : /did not provide a cloudflare login link/i.test(reason)
                  ? "loginLinkMissing"
                  : /timed out/i.test(reason)
                    ? "timeout"
                    : /invalid.*link|invalid.*origin|shared.*token|invitation/i.test(
                          reason,
                        )
                      ? "invalidLink"
                      : `failure.${progress.failedPhase ?? "connecting"}`;

  const steps: RelayProgressStep[] = (
    ["login", "deploying", "connecting"] as const
  ).map((step, index) => ({
    id: step,
    label: t(`connect.phase.${step}`),
    detail:
      step === "deploying" || phase === index
        ? [
            phase === index &&
              t(
                step === "login"
                  ? `connect.login.${loginStatus}`
                  : "connect.inProgress",
              ),
            step === "deploying" && t("connect.twentySeconds"),
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined,
    state: phase > index ? "complete" : phase === index ? "running" : "waiting",
  }));

  return (
    <RelayProgressView
      failed={progress.phase === "failed"}
      failureMessage={t(`connect.${failure}`)}
      accounts={accountOptions.map((item) => ({
        id: item.id,
        label: hidden ? maskSensitive(item.name || item.id, true) : item.name || item.id,
      }))}
      selectedAccount={account}
      chooseAccountLabel={t("connect.chooseAccount")}
      onSelectAccount={setAccount}
      retryLabel={t("retry")}
      retryBusy={busy}
      retryDisabled={Boolean(progress.accounts?.length && !account)}
      onRetry={onRetry}
      steps={steps}
      copyLoginLabel={progress.loginUrl ? t("connect.copyLogin") : undefined}
      onCopyLogin={
        progress.loginUrl
          ? () => void copyText(progress.loginUrl!)
          : undefined
      }
      footer={
        !cancelInFooter ? (
          <DialogActions className="flex w-full items-center justify-between gap-4">
            <Button
              disabled={!closeDialog && busy}
              onClick={closeDialog ?? onCancel}
            >
              {t("cancel")}
            </Button>
            {progress.phase !== "failed" && (
              <Button variant="primary" busy>
                {t("connect.inProgress")}
              </Button>
            )}
          </DialogActions>
        ) : undefined
      }
    />
  );
}

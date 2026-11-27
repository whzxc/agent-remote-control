import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import {
  acceptHubHealth,
  connector,
  refreshConnector,
  refreshHubHealth,
} from "../state/connector";
import type { HubHealth } from "../state/types";
import { HubRecoveryView } from "./connectivity/HubRecoveryView";
import { Button } from "./kit/button";
import { SetupImpact } from "./onboarding/SetupAppearance";
import { Dialog } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";

export async function controlHubCore(action: "stop" | "start" | "restart") {
  const health = await api<HubHealth>("runtime/core", "POST", { action });
  acceptHubHealth(health);
  if (action !== "stop") void refreshConnector().catch(() => {});
  return health;
}

export default function HubRecovery({
  side,
  onClose,
  openCore,
}: {
  side: "remote" | "core";
  onClose: () => void;
  openCore: () => void;
}) {
  const { hubHealth } = connector.use();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const completion = useDialogCompletion(onClose);
  const remote = side === "remote";
  const blocked = remote && hubHealth?.core !== "ready";
  const stopped = hubHealth?.core === "stopped";
  const faults = hubHealth?.remoteFaults ?? [];

  async function perform(action: string, work: () => Promise<boolean>) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      if (await work()) await completion.finish();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(undefined);
    }
  }

  async function retry(fresh = false) {
    const health = await refreshHubHealth(fresh);
    return remote
      ? !health.remoteFaults.length && !health.remoteUnavailable
      : health.core === "ready";
  }

  const restartConnection = (id: string) =>
    perform(id, async () => {
      await api(`ingress/${encodeURIComponent(id)}/restart`, "POST");
      void refreshConnector().catch(() => {});
      return retry(true);
    });

  const reason = remote
    ? blocked
      ? "hub.remoteBlocked"
      : hubHealth?.remoteUnavailable
        ? "hub.remoteCheckFailed"
        : "hub.remoteFailed"
    : stopped
      ? "hub.coreStopped"
      : "hub.coreFailed";

  const showImpact =
    !blocked &&
    (!remote || !hubHealth?.remoteUnavailable) &&
    !(stopped && !remote);

  return (
    <Dialog
      layerId={completion.layerId}
      title={t(remote ? "hub.remoteRecoveryTitle" : "hub.coreRecoveryTitle")}
      busy={!!busy}
      onClose={onClose}
      returnFocus={
        remote
          ? ".hub-remote-recovery, .hub-arc:not([data-paired]) .hub-connections"
          : ".hub-core-action"
      }
      footer={
        blocked ? (
          <Button variant="primary" onClick={openCore}>
            {t("hub.openCoreRecovery")}
          </Button>
        ) : !remote && stopped ? (
          <Button
            variant="primary"
            busy={busy === "start"}
            onClick={() =>
              void perform("start", async () => {
                return (await controlHubCore("start")).core === "ready";
              })
            }
          >
            {t("hub.startCore")}
          </Button>
        ) : (
          <>
            {!remote && (
              <Button
                disabled={!!busy}
                busy={busy === "restart"}
                onClick={() =>
                  void perform("restart", async () => {
                    return (await controlHubCore("restart")).core === "ready";
                  })
                }
              >
                {t("hub.restartCore")}
              </Button>
            )}
            {remote && faults.length === 1 && !hubHealth?.remoteUnavailable && (
              <Button
                disabled={!!busy}
                busy={busy === faults[0].id}
                onClick={() => void restartConnection(faults[0].id)}
              >
                {t("hub.restartConnection")}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!!busy}
              busy={busy === "retry"}
              onClick={() => void perform("retry", retry)}
            >
              {t("retry")}
            </Button>
          </>
        )
      }
    >
      <HubRecoveryView
        reason={t(reason)}
        impact={
          showImpact ? (
            <SetupImpact>
              {t(remote ? "hub.remoteRestartImpact" : "hub.coreRestartImpact")}
            </SetupImpact>
          ) : undefined
        }
        faults={
          remote && !blocked && faults.length > 1 && !hubHealth?.remoteUnavailable
            ? faults.map((fault) => ({
                id: fault.id,
                label: t("hub.restartNamedConnection", { name: fault.name }),
                busy: busy === fault.id,
                onRestart: () => void restartConnection(fault.id),
              }))
            : []
        }
        busy={!!busy}
        error={error || undefined}
      />
    </Dialog>
  );
}

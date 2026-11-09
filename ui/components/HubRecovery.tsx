import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { acceptHubHealth, connector, refreshConnector, refreshHubHealth } from "../state/connector";
import type { HubHealth } from "../state/types";
import { Button, Dialog, Notice } from "./ui";

export async function controlHubCore(action: "stop" | "start" | "restart") {
  const health = await api<HubHealth>("runtime/core", "POST", { action });
  acceptHubHealth(health);
  if (action !== "stop") void refreshConnector().catch(() => {});
  return health;
}

export default function HubRecovery({ side, onClose, openCore }: {
  side: "remote" | "core";
  onClose: () => void;
  openCore: () => void;
}) {
  const { hubHealth } = connector.use();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const remote = side === "remote";
  const blocked = remote && hubHealth?.core !== "ready";
  const stopped = hubHealth?.core === "stopped";
  const faults = hubHealth?.remoteFaults ?? [];
  async function perform(action: string, work: () => Promise<boolean>) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      if (await work()) onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(undefined);
    }
  }
  async function retry(fresh = false) {
    const health = await refreshHubHealth(fresh);
    return remote ? !health.remoteFaults.length && !health.remoteUnavailable : health.core === "ready";
  }
  const restartConnection = (id: string) => perform(id, async () => {
    await api(`ingress/${encodeURIComponent(id)}/restart`, "POST");
    void refreshConnector().catch(() => {});
    return retry(true);
  });
  const reason = remote
    ? blocked ? "hub.remoteBlocked" : hubHealth?.remoteUnavailable ? "hub.remoteCheckFailed" : "hub.remoteFailed"
    : stopped ? "hub.coreStopped" : "hub.coreFailed";
  return <Dialog centered width={380} title={t(remote ? "hub.remoteRecoveryTitle" : "hub.coreRecoveryTitle")}
    busy={!!busy} onClose={onClose} returnFocus={remote ? ".hub-connections" : ".hub-core-action"}
    footer={blocked
      ? <Button variant="primary" onClick={openCore}>{t("hub.openCoreRecovery")}</Button>
      : !remote && stopped
        ? <Button variant="primary" busy={busy === "start"} onClick={() => void perform("start", async () => {
          return (await controlHubCore("start")).core === "ready";
        })}>{t("hub.startCore")}</Button>
        : <>
          {!remote && <Button disabled={!!busy} busy={busy === "restart"} onClick={() => void perform("restart", async () => {
            return (await controlHubCore("restart")).core === "ready";
          })}>{t("hub.restartCore")}</Button>}
          {remote && faults.length === 1 && !hubHealth?.remoteUnavailable && <Button disabled={!!busy} busy={busy === faults[0].id}
            onClick={() => void restartConnection(faults[0].id)}>{t("hub.restartConnection")}</Button>}
          <Button variant="primary" disabled={!!busy} busy={busy === "retry"} onClick={() => void perform("retry", retry)}>{t("retry")}</Button>
        </>}>
    <div className="hub-recovery-reason">
      <p>{t(reason)}</p>
      {!blocked && (!remote || !hubHealth?.remoteUnavailable) && !(stopped && !remote) &&
        <p className="hub-recovery-impact">{t(remote ? "hub.remoteRestartImpact" : "hub.coreRestartImpact")}</p>}
      {remote && !blocked && faults.length > 1 && !hubHealth?.remoteUnavailable && faults.map(fault =>
        <Button key={fault.id} disabled={!!busy} busy={busy === fault.id} onClick={() => void restartConnection(fault.id)}>{t("hub.restartNamedConnection", { name: fault.name })}</Button>)}
      {error && <Notice>{error}</Notice>}
    </div>
  </Dialog>;
}

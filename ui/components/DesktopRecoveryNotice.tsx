import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { taskErrorText } from "../state/taskErrors";
import { refreshTasks, type TaskRecord } from "../state/tasks";
import { Button, Notice } from "./ui";

export function awaitsDesktopDecision(record: TaskRecord) {
  return record.state === "awaiting-approval" && record.desktopRecovery?.state === "waiting-for-local";
}

export default function DesktopRecoveryNotice({ record }: { record: TaskRecord }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recovery = record.desktopRecovery;
  const desktopDecisionId = recovery?.decisionId;
  if (!awaitsDesktopDecision(record) || !recovery || !desktopDecisionId) return null;
  async function decide(action: "restart-desktop" | "independent-desktop" | "reject") {
    setBusy(true);
    setError("");
    try {
      await api("tasks/decision", "POST", { requestId: record.requestId, action, desktopDecisionId });
      await refreshTasks();
    } catch (failure) {
      setError(taskErrorText(failure, "desktopRecovery.decisionFailed"));
      await refreshTasks();
    } finally {
      setBusy(false);
    }
  }
  const ambiguous = recovery.reason === "ambiguous-desktop";
  return <Notice title={record.task.title || t("taskRequest")} tone={error ? "danger" : "warning"} actionBelow action={<div className="actions">
    <Button disabled={busy} onClick={() => void decide("reject")}>{t("cancel")}</Button>
    {!ambiguous && <Button disabled={busy} onClick={() => void decide("restart-desktop")}>{t(recovery.target ? "desktopRecovery.restartAction" : "desktopRecovery.startAction")}</Button>}
    <Button disabled={busy} onClick={() => void decide("independent-desktop")}>{t("desktopRecovery.independentAction")}</Button>
  </div>}>
    {error || (recovery.target ? t("desktopRecovery.restartImpact", { pid: recovery.target.pid }) : t(ambiguous ? "desktopRecovery.ambiguous" : "desktopRecovery.notReady"))}
  </Notice>;
}

import { readOnlyBrowser } from "../browserMode";
import type { AgentActivitySession } from "../types";
import { t } from "../i18n";
import { activityApprovals, submitActivityApproval } from "../state/activity";
import { interactionKey, permissionResponse } from "../state/activityModel";
import { Button, Tooltip } from "./ui";
import { taskErrorText } from "../state/taskErrors";

export default function ActivityInteraction({ agent, session }: { agent: string; session: AgentActivitySession }) {
  const submissions = activityApprovals.use();
  const submission = submissions[interactionKey(agent, session)];
  const interaction = session.interaction;
  if (!interaction || interaction.kind !== "permission") return null;
  if (submission?.status === "submitted" || submission?.status === "unconfirmed") return <span role="status">{t(submission.status === "submitted" ? "activity.submitted" : "activity.unconfirmed")}</span>;
  return <div className="activity-actions">
    <span className="activity-once">{t("timeline.allowOnce")}</span>
    <Button variant="secondary" disabled={readOnlyBrowser || !permissionResponse(interaction, "deny") || !!submission && submission.decision !== "deny"} busy={submission?.status === "submitting" && submission.decision === "deny"} onClick={() => void submitActivityApproval(agent, session, "deny")}>{t("detail.reject")}</Button>
    <Tooltip text={t("detail.nativeBypassUnavailable")}><span tabIndex={0}><Button variant="secondary" disabled>{t("detail.bypass")}</Button></span></Tooltip>
    <Button disabled={readOnlyBrowser || !permissionResponse(interaction, "allow") || !!submission && submission.decision !== "allow"} busy={submission?.status === "submitting" && submission.decision === "allow"} onClick={() => void submitActivityApproval(agent, session, "allow")}>{t("detail.approve")}</Button>
    {!permissionResponse(interaction, "allow") && <span className="timeline-meta">{t("timeline.responseUnavailable")}</span>}
    {submission?.status === "pending" && <span role="status">{t("activity.checkResult")}</span>}
    {submission?.status === "failed" && <span role="alert">{taskErrorText(submission.error)}</span>}
  </div>;
}

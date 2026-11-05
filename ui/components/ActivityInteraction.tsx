import type { ReactNode } from "react";
import { readOnlyBrowser } from "../browserMode";
import type { AgentActivitySession } from "../types";
import { t } from "../i18n";
import { activityApprovals, submitActivityApproval } from "../state/activity";
import { interactionKey, permissionResponse } from "../state/activityModel";
import { Button, Tooltip } from "./ui";
import { taskErrorText } from "../state/taskErrors";

export default function ActivityInteraction({ agent, session, routing }: { routing?: ReactNode; agent: string; session: AgentActivitySession }) {
  const submissions = activityApprovals.use();
  const submission = submissions[interactionKey(agent, session)];
  const interaction = session.interaction;
  if (!interaction || interaction.kind !== "permission") return null;
  const settled = submission?.status === "submitted" || submission?.status === "unconfirmed";
  return <>
    {!permissionResponse(interaction, "allow") && <span className="timeline-meta">{t("timeline.responseUnavailable")}</span>}
    {settled && <span role="status">{t(submission.status === "submitted" ? "activity.submitted" : "activity.unconfirmed")}</span>}
    {submission?.status === "pending" && <span role="status">{t("activity.checkResult")}</span>}
    {submission?.status === "failed" && <span role="alert">{taskErrorText(submission.error)}</span>}
    {routing}
    <div className="activity-actions">
    <Button variant="secondary" disabled={readOnlyBrowser || settled || !permissionResponse(interaction, "deny") || !!submission && submission.decision !== "deny"} busy={submission?.status === "submitting" && submission.decision === "deny"} onClick={() => void submitActivityApproval(agent, session, "deny")}>{t("detail.reject")}</Button>
    <Tooltip text={t("detail.nativeBypassUnavailable")}><span tabIndex={0}><Button variant="secondary" disabled>{t("detail.bypass")}</Button></span></Tooltip>
    <Button variant="primary" disabled={readOnlyBrowser || settled || !permissionResponse(interaction, "allow") || !!submission && submission.decision !== "allow"} busy={submission?.status === "submitting" && submission.decision === "allow"} onClick={() => void submitActivityApproval(agent, session, "allow")}>{t("detail.approve")}</Button>
    </div>
  </>;
}

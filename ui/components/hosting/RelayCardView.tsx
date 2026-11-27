import { Cloud } from "lucide-react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Badge } from "../kit/badge";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import { SensitiveText } from "../kit/privacy";
import {
  RelayDevicesTableView,
  type RelayMemberRow,
} from "./RelayDevicesTableView";

export interface RelayCardViewProps {
  hostname: string;
  hasUrl: boolean;
  running: boolean;
  outdated: boolean;
  copied?: boolean;
  shareBusy?: boolean;
  disabled?: boolean;
  members: readonly RelayMemberRow[];
  membersLoading?: boolean;
  membersError?: string;
  error?: string;
  onRedeploy?: () => void;
  onShare?: () => void;
  onResetToken?: () => void;
  onRefreshMembers?: () => void;
  onRemoveMember?: (member: RelayMemberRow) => void;
  onDelete?: () => void;
}

export function RelayCardView({
  hostname,
  hasUrl,
  running,
  outdated,
  copied = false,
  shareBusy = false,
  disabled = false,
  members,
  membersLoading = false,
  membersError,
  error,
  onRedeploy,
  onShare,
  onResetToken,
  onRefreshMembers,
  onRemoveMember,
  onDelete,
}: RelayCardViewProps) {
  const { t } = useI18n();

  return (
    <article
      className="hosted-relay grid gap-5"
      aria-label={t("hosting.title")}
    >
      <Card className="hosted-relay-card gap-0 overflow-hidden p-0">
        <div className="hosted-relay-summary flex items-center gap-3 p-4">
          <div className="hosted-relay-icon grid size-9 shrink-0 place-items-center rounded-tile border border-border bg-surface-subtle text-text-secondary">
            <Cloud size={16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          </div>
          <div className="hosted-relay-identity min-w-0 flex-1">
            <h3 className="m-0 truncate font-mono text-small font-medium leading-5 text-foreground">
              <SensitiveText>{hostname}</SensitiveText>
            </h3>
            <div className="hosted-relay-provider mt-0.5 flex flex-wrap items-center gap-1 text-meta leading-4 text-text-secondary">
              <span>Cloudflare Workers</span>
              <span aria-hidden="true">·</span>
              {outdated || !hasUrl ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  onClick={onRedeploy}
                >
                  {t(outdated && hasUrl ? "hosting.update" : "retry")}
                </Button>
              ) : (
                <span>{t("hosting.upToDate")}</span>
              )}
            </div>
          </div>
          <Badge
            dot
            tone={running ? "success" : "neutral"}
            className="shrink-0"
          >
            {t(running ? "hosting.running" : "connect.offline")}
          </Badge>
        </div>

        <div className="hosted-relay-invite flex flex-wrap items-center gap-3 border-t border-border bg-surface-subtle/60 px-4 py-3">
          <p className="m-0 min-w-[200px] flex-1 text-small leading-5 text-foreground">
            {t("hosting.invite")}
            <span className="text-text-secondary">
              {" "}
              · {t("hosting.inviteDescription")}
            </span>
          </p>
          <div className="actions ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              busy={shareBusy}
              disabled={disabled || !hasUrl}
              onClick={onShare}
            >
              {t(copied ? "copied" : "hosting.copyInvite")}
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !hasUrl}
              onClick={onResetToken}
            >
              {t("hosting.reset")}
            </Button>
          </div>
        </div>
      </Card>

      <RelayDevicesTableView
        members={members}
        loading={membersLoading}
        error={membersError}
        disabled={disabled || !hasUrl}
        onRefresh={onRefreshMembers}
        onRemove={onRemoveMember}
      />

      <div className="hosted-relay-danger flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-[240px] flex-1">
          <h3 className="m-0 text-body font-semibold leading-5 text-foreground">
            {t("hosting.deleteTitle")}
          </h3>
          <p className="mt-1 text-small leading-5 text-text-secondary">
            {t("hosting.deleteDescription")}
          </p>
        </div>
        <Button variant="danger" disabled={disabled} onClick={onDelete}>
          {t("hosting.delete")}
        </Button>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
    </article>
  );
}

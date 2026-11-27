import { RefreshCw, RotateCw } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import { Progress } from "../kit/progress";
import { HintTooltip } from "../kit/tooltip";
import {
  ReleaseNoteGroupsView,
  type ReleaseNoteGroup,
} from "./ReleaseNoteGroupsView";

export type {
  ReleaseNoteBullet,
  ReleaseNoteEntry,
  ReleaseNoteGroup,
} from "./ReleaseNoteGroupsView";
export { ReleaseNoteGroupsView } from "./ReleaseNoteGroupsView";

export interface UpdatePanelViewProps {
  showHeader?: boolean;
  targetVersion?: string;
  currentVersion?: string;
  phase: "idle" | "checking" | "downloading" | "installing" | string;
  ready?: boolean;
  available?: boolean;
  downloadedAmount?: string;
  progressPercent?: number;
  error?: string;
  actionError?: string;
  message?: string;
  noteGroups: readonly ReleaseNoteGroup[];
  showNoteVersions?: boolean;
  renderMarkdown?: (text: string, inline?: boolean) => ReactNode;
  onDismiss?: () => void;
  onPrimaryAction?: () => void;
  onRetryCheck?: () => void;
}

export function UpdatePanelView({
  showHeader = true,
  targetVersion,
  currentVersion,
  phase,
  ready = false,
  available = false,
  downloadedAmount,
  progressPercent,
  error,
  actionError,
  message,
  noteGroups,
  showNoteVersions = false,
  renderMarkdown,
  onDismiss,
  onPrimaryAction,
  onRetryCheck,
}: UpdatePanelViewProps): ReactElement {
  const { t } = useI18n();
  const downloading = phase === "downloading";
  const installing = phase === "installing";
  const checking = phase === "checking";
  const active = checking || downloading || installing;
  const releaseStatus = downloading
    ? t("updates.downloading")
    : ready && !installing
      ? t("updates.ready")
      : "";
  const metadata = [
    currentVersion && t("updates.currentVersion", { version: currentVersion }),
    releaseStatus,
  ]
    .filter(Boolean)
    .join(" · ");
  const errorLabel = targetVersion
    ? ready
      ? "updates.installFailed"
      : "updates.downloadFailed"
    : "updates.checkFailed";
  const primaryLabel = installing
    ? "updates.installing"
    : ready
      ? error
        ? "updates.retryInstall"
        : "updates.restartNow"
      : error
        ? "updates.retryDownload"
        : "downloadUpdate";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {showHeader && (
        <header className="flex min-h-(--kit-control-height) flex-none items-center">
          <h2 className="m-0 text-title font-semibold leading-6 text-foreground">
            {targetVersion
              ? t("updates.targetVersion", { version: targetVersion })
              : t("appUpdates")}
          </h2>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {actionError && !error && (
          <Notice compact tone="danger">
            {actionError}
          </Notice>
        )}
        {(metadata || downloading) && (
          <div className="flex flex-col gap-2">
            <div
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta leading-4 text-text-secondary"
              role="status"
            >
              <span>{metadata}</span>
              {downloading && downloadedAmount && (
                <span className="tabular-nums">{downloadedAmount}</span>
              )}
            </div>
            {downloading && progressPercent !== undefined && (
              <Progress
                aria-label={t("updateDownloadProgress")}
                value={Math.max(0, Math.min(100, progressPercent))}
              />
            )}
          </div>
        )}
        {error && (
          <Notice compact tone="danger">
            <HintTooltip text={error}>
              <span>{t(errorLabel)}</span>
            </HintTooltip>
          </Notice>
        )}
        {targetVersion && (
          <Card
            padded
            render={<section tabIndex={0} aria-label={t("updates.notes")} />}
            className="max-h-[280px] min-w-0 overflow-y-auto bg-surface-subtle/50"
          >
            <ReleaseNoteGroupsView
              groups={noteGroups}
              showVersions={showNoteVersions}
              renderMarkdown={renderMarkdown}
            />
          </Card>
        )}
        {(checking || message) && (
          <p className="m-0 text-small text-text-secondary" role="status">
            {checking ? t("checkingLabel") : message}
          </p>
        )}
      </div>
      <footer className="mt-1 flex flex-none flex-col gap-2.5">
        {ready && (
          <p className="m-0 text-meta leading-4 text-text-secondary">
            {t("updates.restartEffect")}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button disabled={installing} variant="ghost" onClick={onDismiss}>
            {t(targetVersion ? "updates.later" : "close")}
          </Button>
          {available && !downloading && (
            <Button variant="primary" busy={active} onClick={onPrimaryAction}>
              {!installing &&
                (ready ? (
                  <RotateCw
                    size={14}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw
                    size={14}
                    strokeWidth={1.75}
                    absoluteStrokeWidth
                    aria-hidden="true"
                  />
                ))}
              <span aria-live="polite">{t(primaryLabel)}</span>
            </Button>
          )}
          {!targetVersion && error && (
            <Button variant="primary" onClick={onRetryCheck}>
              {t("updateCheckRetry")}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

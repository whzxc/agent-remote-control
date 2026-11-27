import { ArrowUpRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import {
  ReleaseNoteGroupsView,
  type ReleaseNoteGroup,
} from "./UpdatePanelView";

export interface UpdateHistoryReleaseItem {
  version: string;
  groups: readonly ReleaseNoteGroup[];
}

export interface UpdateHistoryViewProps {
  releases?: readonly UpdateHistoryReleaseItem[];
  loading?: boolean;
  failed?: boolean;
  actionError?: string;
  renderMarkdown?: (text: string, inline?: boolean) => ReactNode;
  onRetry?: () => void;
  onOpenAllReleases?: () => void;
}

export function UpdateHistoryView({
  releases,
  loading = false,
  failed = false,
  actionError,
  renderMarkdown,
  onRetry,
  onOpenAllReleases,
}: UpdateHistoryViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {actionError && (
        <Notice compact tone="danger">
          {actionError}
        </Notice>
      )}
      {failed ? (
        <Notice
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t("retry")}
            </Button>
          }
        >
          {t("updates.historyFailed")}
        </Notice>
      ) : loading || !releases ? (
        <p className="m-0 text-small text-text-secondary" role="status">
          {t("updates.historyLoading")}
        </p>
      ) : !releases.length ? (
        <p className="m-0 text-small text-text-secondary">
          {t("updates.noNotes")}
        </p>
      ) : (
        <div
          className="flex max-h-[360px] flex-col gap-2.5 overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={t("updates.history")}
        >
          {releases.map((release) => (
            <Card key={release.version} padded className="gap-2.5">
              <h3 className="m-0 font-mono text-body font-semibold leading-5 text-foreground">
                {release.version}
              </h3>
              <ReleaseNoteGroupsView
                groups={release.groups}
                headingLevel="h4"
                renderMarkdown={renderMarkdown}
              />
            </Card>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="link" onClick={onOpenAllReleases}>
          {t("updates.allReleases")}
          <ArrowUpRight
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
          />
        </Button>
      </div>
    </div>
  );
}

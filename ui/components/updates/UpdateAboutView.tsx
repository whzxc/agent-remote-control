import { ChevronRight, ExternalLink } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { Button, IconButton } from "../kit/button";
import { HintTooltip } from "../kit/tooltip";
import { Setting, SettingsSection } from "../settings/SettingsRows";

export interface UpdateAboutViewProps {
  currentVersion?: string;
  checkLabel: string;
  checkTooltip?: string;
  checking?: boolean;
  checkDisabled?: boolean;
  updateAvailable?: boolean;
  actionError?: string;
  repositoryLabel?: string;
  overflowMenuSlot?: ReactNode;
  trailingNavSlot?: ReactNode;
  onCheckUpdate?: () => void;
  onViewUpdate?: () => void;
  onOpenHistory?: () => void;
  onOpenRepository?: () => void;
}

export function UpdateAboutView({
  currentVersion,
  checkLabel,
  checkTooltip,
  checking = false,
  checkDisabled = false,
  updateAvailable = false,
  actionError,
  repositoryLabel = "whzxc/agent-remote-control",
  overflowMenuSlot,
  trailingNavSlot,
  onCheckUpdate,
  onViewUpdate,
  onOpenHistory,
  onOpenRepository,
}: UpdateAboutViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <section className="settings-about flex min-w-0 flex-col gap-2.5">
      {actionError && (
        <Notice compact tone="danger">
          {actionError}
        </Notice>
      )}
      <SettingsSection title={t("aboutApp")}>
        <Setting title={`ARC ${currentVersion ?? "—"}`}>
          <div className="flex items-center justify-end gap-1.5">
            <HintTooltip text={checkTooltip || checkLabel}>
              <Button
                variant="secondary"
                size="sm"
                busy={checking}
                disabled={checkDisabled}
                onClick={onCheckUpdate}
              >
                <span aria-live="polite">{checkLabel}</span>
              </Button>
            </HintTooltip>
            {updateAvailable && (
              <>
                <Button size="sm" variant="primary" onClick={onViewUpdate}>
                  {t("viewUpdate")}
                </Button>
                {overflowMenuSlot}
              </>
            )}
          </div>
        </Setting>
        <Setting title={t("updates.history")}>
          <IconButton
            compact
            icon={ChevronRight}
            label={t("updates.history")}
            onClick={onOpenHistory}
          />
        </Setting>
      </SettingsSection>
      <nav
        className="flex flex-wrap items-center gap-2 px-4"
        aria-label={t("aboutApp")}
      >
        <span className="font-mono text-meta text-text-secondary">
          {repositoryLabel}
        </span>
        <Button size="sm" variant="ghost" onClick={onOpenRepository}>
          GitHub
          <ExternalLink
            size={14}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
          />
        </Button>
        {trailingNavSlot && <div className="ml-auto">{trailingNavSlot}</div>}
      </nav>
    </section>
  );
}

import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { HintTooltip } from "../kit/tooltip";
import { AgentBrandGlyph } from "./AgentSettingsGridView";

export interface AgentDetailViewProps {
  title: string;
  iconMarkup?: string;
  icon?: ReactNode;
  version?: string;
  versionText?: string;
  officialLink?: string;
  discoveryMessage?: string;
  discoveryError?: string;
  quotaSlot?: ReactNode;
  dispatchDefaultsSlot?: ReactNode;
  onOpenOfficialLink?: () => void;
}

export function AgentDetailView({
  title,
  iconMarkup,
  icon,
  version,
  versionText,
  officialLink,
  discoveryMessage,
  discoveryError,
  quotaSlot,
  dispatchDefaultsSlot,
  onOpenOfficialLink,
}: AgentDetailViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="agent-summary my-0! flex items-center gap-3 pr-8">
        <AgentBrandGlyph markup={iconMarkup} icon={icon} size={36} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="m-0 truncate text-title font-semibold leading-6 text-foreground">
            {title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta leading-4 text-text-secondary">
            {versionText && (
              <HintTooltip text={version || undefined}>
                <p className="m-0">{versionText}</p>
              </HintTooltip>
            )}
            {officialLink && (
              <a
                href={officialLink}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenOfficialLink?.();
                }}
                className="text-small text-accent-text no-underline hover:underline"
              >
                {t("officialSetup")}
              </a>
            )}
          </div>
        </div>
      </div>
      {discoveryError && discoveryMessage && (
        <Notice compact tone="danger">
          {discoveryMessage}
          <br />
          <small>{discoveryError}</small>
        </Notice>
      )}
      {quotaSlot}
      {dispatchDefaultsSlot}
    </div>
  );
}

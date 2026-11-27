import { Gauge, Settings } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { IconButton } from "../kit/button";
import { Loading } from "../kit/spinner";
import {
  AgentBrandGlyph,
  AgentInventoryCardView,
  type AgentCardItem,
} from "./AgentInventoryCardView";

export {
  AgentBrandGlyph,
  AgentInventoryCardView,
  type AgentCardItem,
  type QuotaTone,
} from "./AgentInventoryCardView";

export interface UninstalledAgentItem {
  id: string;
  title: string;
  link?: string;
  iconMarkup?: string;
  icon?: ReactNode;
}

export interface AgentSettingsGridViewProps {
  installed: readonly AgentCardItem[];
  uninstalled: readonly UninstalledAgentItem[];
  loaded?: boolean;
  loading?: boolean;
  loadError?: string;
  actionError?: string;
  onOpenOverview?: () => void;
  onOpenDisplaySettings?: () => void;
  onOpenAgent?: (id: string) => void;
  onToggleAgent?: (id: string, enabled: boolean) => void;
  onOpenLink?: (href: string) => void;
  renderInstalledCard?: (agent: AgentCardItem) => ReactNode;
}

export function AgentSettingsGridView({
  installed,
  uninstalled,
  loaded = true,
  loading = false,
  loadError,
  actionError,
  onOpenOverview,
  onOpenDisplaySettings,
  onOpenAgent,
  onToggleAgent,
  onOpenLink,
  renderInstalledCard,
}: AgentSettingsGridViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-h-8 items-center gap-1.5">
          <h3 className="m-0 mr-2 text-meta font-semibold leading-4 text-text-secondary">
            {t("installedAgents")}
          </h3>
          <IconButton
            compact
            icon={Gauge}
            label={t("trayUsage")}
            onClick={onOpenOverview}
          />
          <IconButton
            compact
            icon={Settings}
            label={t("agentDisplaySettings")}
            onClick={onOpenDisplaySettings}
          />
        </div>
        {!loaded && loading && <Loading />}
        {!loaded && !loading && !loadError && (
          <Notice compact tone="info">
            {t("agentsNotLoaded")}
          </Notice>
        )}
        {!!loadError && (
          <Notice compact tone="danger">
            {t("agentsRequestFailed")}
            <br />
            <small>{loadError}</small>
          </Notice>
        )}
        {loaded &&
          !loadError &&
          installed.length === 0 &&
          uninstalled.length === 0 && (
            <Notice compact tone="info">
              {t("agentsEmpty")}
            </Notice>
          )}
        {installed.length > 0 && (
          <div className="agent-grid grid grid-cols-[repeat(auto-fill,minmax(min(100%,272px),1fr))] gap-3">
            {installed.map((agent) =>
              renderInstalledCard ? (
                renderInstalledCard(agent)
              ) : (
                <AgentInventoryCardView
                  key={agent.id}
                  agent={agent}
                  onOpen={() => onOpenAgent?.(agent.id)}
                  onOpenLink={onOpenLink}
                  onToggle={(enabled) => onToggleAgent?.(agent.id, enabled)}
                />
              ),
            )}
          </div>
        )}
      </div>

      {uninstalled.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 text-meta font-semibold leading-4 text-text-secondary">
            {t("notInstalledAgents")}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,208px),1fr))] gap-2">
            {uninstalled.map((agent) => (
              <a
                key={agent.id}
                href={agent.link}
                onClick={(event) => {
                  if (!agent.link) return;
                  event.preventDefault();
                  onOpenLink?.(agent.link);
                }}
                className="flex min-w-0 items-center gap-2 rounded-kit-field border border-border bg-surface-subtle px-3 py-2 text-small text-text-secondary no-underline hover:border-border-strong hover:text-foreground"
              >
                <AgentBrandGlyph
                  markup={agent.iconMarkup}
                  icon={agent.icon}
                  size={20}
                />
                <span className="truncate">{agent.title}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {actionError && (
        <Notice compact tone="danger">
          {actionError}
        </Notice>
      )}
    </div>
  );
}

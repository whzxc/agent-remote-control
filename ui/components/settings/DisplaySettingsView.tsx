import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Notice } from "../kit/alert";
import { SegmentedControl } from "../kit/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { Switch } from "../kit/switch";
import { Setting, SettingsSection, SettingsStack } from "./SettingsRows";

export type DisplayLayoutMode = "auto" | "landscape" | "portrait";
export type QuotaDisplayMode = "remaining" | "used";
export type ResetDisplayMode = "countdown" | "time";

export interface DisplaySettingsViewProps {
  error?: string;
  dispatchDefaultsSlot?: ReactNode;
  showLayout?: boolean;
  layout?: DisplayLayoutMode;
  onLayoutChange?: (value: DisplayLayoutMode) => void;
  maxVisibleAgents: number;
  onMaxVisibleAgentsChange?: (value: number) => void;
  quotaEnabled: boolean;
  quotaDisabled?: boolean;
  onQuotaEnabledChange?: (value: boolean) => void;
  quotaDisplay: QuotaDisplayMode;
  onQuotaDisplayChange?: (value: QuotaDisplayMode) => void;
  resetDisplay: ResetDisplayMode;
  onResetDisplayChange?: (value: ResetDisplayMode) => void;
  refreshMinutes: number;
  refreshDisabled?: boolean;
  onRefreshMinutesChange?: (value: number) => void;
}

export function DisplaySettingsView({
  error,
  dispatchDefaultsSlot,
  showLayout = true,
  layout = "auto",
  onLayoutChange,
  maxVisibleAgents,
  onMaxVisibleAgentsChange,
  quotaEnabled,
  quotaDisabled = false,
  onQuotaEnabledChange,
  quotaDisplay,
  onQuotaDisplayChange,
  resetDisplay,
  onResetDisplayChange,
  refreshMinutes,
  refreshDisabled = false,
  onRefreshMinutesChange,
}: DisplaySettingsViewProps): ReactElement {
  const { t } = useI18n();
  const resetOptions: readonly { value: ResetDisplayMode; label: string }[] = [
    { value: "countdown", label: t("usageCountdown") },
    { value: "time", label: t("usageResetTime") },
  ];
  const resetLabel =
    resetOptions.find((option) => option.value === resetDisplay)?.label ??
    resetOptions[0].label;

  return (
    <div className="display-settings min-w-0">
      <SettingsStack>
        {error && (
          <Notice compact tone="danger">
            {error}
          </Notice>
        )}
        {dispatchDefaultsSlot}
        <SettingsSection title={t("usageAppearance")}>
          {showLayout && (
            <Setting title={t("topology.layout")}>
              <SegmentedControl
                aria-label={t("topology.layout")}
                value={layout}
                onValueChange={(next) => onLayoutChange?.(next)}
                options={[
                  { value: "auto", label: t("topology.layout.auto") },
                  { value: "landscape", label: t("topology.layout.landscape") },
                  { value: "portrait", label: t("topology.layout.portrait") },
                ]}
              />
            </Setting>
          )}
          <Setting title={t("agentsMaxVisible")}>
            <SegmentedControl
              aria-label={t("agentsMaxVisible")}
              value={String(maxVisibleAgents)}
              onValueChange={(next) => onMaxVisibleAgentsChange?.(Number(next))}
              options={["4", "6", "8", "10"].map((value) => ({
                value,
                label: value,
              }))}
            />
          </Setting>
        </SettingsSection>

        <SettingsSection title={t("agentQuotaGroup")}>
          <Setting title={t("usageEnabled")} toggle>
            <Switch
              aria-label={t("usageEnabled")}
              checked={quotaEnabled}
              disabled={quotaDisabled}
              onCheckedChange={(checked) => onQuotaEnabledChange?.(checked)}
            />
          </Setting>
          <Setting title={t("agentQuotaDisplay")}>
            <SegmentedControl
              aria-label={t("agentQuotaDisplay")}
              value={quotaDisplay}
              onValueChange={(next) => onQuotaDisplayChange?.(next)}
              options={[
                { value: "remaining", label: t("usageRemaining") },
                { value: "used", label: t("usageUsed") },
              ]}
            />
          </Setting>
          <Setting title={t("agentResetDisplay")} width={200}>
            <Select
              value={resetDisplay}
              onValueChange={(next) => {
                if (next != null) {
                  onResetDisplayChange?.(next as ResetDisplayMode);
                }
              }}
            >
              <SelectTrigger
                aria-label={t("agentResetDisplay")}
                className="w-full"
              >
                <SelectValue>{resetLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {resetOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Setting>
          <Setting title={t("usageAutoRefresh")}>
            <SegmentedControl
              size="sm"
              aria-label={t("usageAutoRefresh")}
              value={String(refreshMinutes)}
              disabled={refreshDisabled}
              onValueChange={(next) => onRefreshMinutesChange?.(Number(next))}
              options={["1", "3", "5", "10"].map((value) => ({
                value,
                label: `${value} min`,
              }))}
            />
          </Setting>
        </SettingsSection>
      </SettingsStack>
    </div>
  );
}

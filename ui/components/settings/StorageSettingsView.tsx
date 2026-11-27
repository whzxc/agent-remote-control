import type { ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { Notice, type AlertTone } from "../kit/alert";
import { Button } from "../kit/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { Switch } from "../kit/switch";
import { Setting, SettingsSection, SettingsStack } from "./SettingsRows";

export interface StorageSettingsViewProps {
  archiveDescription: string;
  cleanupDescription: string;
  outputsMaxAgeDays: number;
  retention: string;
  onRetentionChange?: (value: string) => void;
  archiving?: boolean;
  archiveDisabled?: boolean;
  onArchiveNow?: () => void;
  cleanupDisabled?: boolean;
  onOpenCleanup?: () => void;
  notice?: { message: string; tone?: AlertTone };
}

export function StorageSettingsView({
  archiveDescription,
  cleanupDescription,
  outputsMaxAgeDays,
  retention,
  onRetentionChange,
  archiving = false,
  archiveDisabled = false,
  onArchiveNow,
  cleanupDisabled = false,
  onOpenCleanup,
  notice,
}: StorageSettingsViewProps): ReactElement {
  const { t } = useI18n();
  const retentionOptions = [
    { value: "0", label: t("storage.retentionForever") },
    { value: "30", label: t("storage.retentionDays", { days: 30 }) },
    { value: "90", label: t("storage.retentionDays", { days: 90 }) },
    { value: "180", label: t("storage.retentionDays", { days: 180 }) },
  ] as const;
  const retentionLabel =
    retentionOptions.find((option) => option.value === retention)?.label ??
    retentionOptions[0].label;

  return (
    <SettingsSection title={t("storage.title")}>
      {notice && (
        <div className="p-3">
          <Notice compact tone={notice.tone ?? "info"}>
            {notice.message}
          </Notice>
        </div>
      )}
      <Setting
        title={t("storage.localArchive")}
        description={archiveDescription}
      >
        <Button
          variant="primary"
          busy={archiving}
          disabled={archiveDisabled}
          onClick={onArchiveNow}
        >
          {t("storage.archiveNow")}
        </Button>
      </Setting>
      <Setting
        title={t("storage.retention")}
        description={t("storage.retentionDescription", {
          days: outputsMaxAgeDays,
        })}
        width={180}
      >
        <Select
          value={retention}
          onValueChange={(next) => {
            if (next != null) onRetentionChange?.(next);
          }}
        >
          <SelectTrigger
            aria-label={t("storage.retention")}
            className="w-full"
          >
            <SelectValue>{retentionLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {retentionOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Setting>
      <Setting title={t("storage.cleanup")} description={cleanupDescription}>
        <Button
          variant="secondary"
          disabled={cleanupDisabled}
          onClick={onOpenCleanup}
        >
          {t("storage.previewCleanup")}
        </Button>
      </Setting>
    </SettingsSection>
  );
}

export interface StoragePruneDialogBodyViewProps {
  outputsMaxAgeDays: number;
  includeOutputs: boolean;
  includeLegacy: boolean;
  disabled?: boolean;
  summaryText: string;
  onIncludeOutputsChange?: (value: boolean) => void;
  onIncludeLegacyChange?: (value: boolean) => void;
  Section?: typeof SettingsSection;
  Row?: typeof Setting;
}

export function StoragePruneDialogBodyView({
  outputsMaxAgeDays,
  includeOutputs,
  includeLegacy,
  disabled = false,
  summaryText,
  onIncludeOutputsChange,
  onIncludeLegacyChange,
  Section = SettingsSection,
  Row = Setting,
}: StoragePruneDialogBodyViewProps): ReactElement {
  const { t } = useI18n();
  const outputsTitle = t("storage.includeOutputs", { days: outputsMaxAgeDays });

  return (
    <SettingsStack>
      <Section>
        <Row
          title={outputsTitle}
          description={t("storage.includeOutputsDescription", {
            days: outputsMaxAgeDays,
          })}
          toggle
        >
          <Switch
            aria-label={outputsTitle}
            checked={includeOutputs}
            disabled={disabled}
            onCheckedChange={(checked) => onIncludeOutputsChange?.(checked)}
          />
        </Row>
        <Row
          title={t("storage.includeLegacy")}
          description={t("storage.includeLegacyDescription")}
          toggle
        >
          <Switch
            aria-label={t("storage.includeLegacy")}
            checked={includeLegacy}
            disabled={disabled}
            onCheckedChange={(checked) => onIncludeLegacyChange?.(checked)}
          />
        </Row>
        <Row
          title={t("storage.pruneSummaryTitle")}
          description={summaryText}
        >
          <span />
        </Row>
      </Section>
    </SettingsStack>
  );
}

import type { ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { Card } from "../kit/card";
import { Switch } from "../kit/switch";
import {
  Setting,
  SettingLine,
  SettingsSection,
  SettingsStack,
} from "./SettingsRows";

export interface DeviceExperimentCardViewProps {
  enabled: boolean;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
}

export function DeviceExperimentCardView({
  enabled,
  disabled = false,
  onChange,
}: DeviceExperimentCardViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <Card className="device-experiment gap-0 overflow-hidden p-0">
      <SettingLine title={t("device.deviceLink")}>
        <Switch
          aria-label={t("device.deviceLink")}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange?.(checked)}
        />
      </SettingLine>
    </Card>
  );
}

export interface ExperimentalSettingsViewProps {
  devicesEnabled: boolean;
  mcpEnabled: boolean;
  hostingEnabled: boolean;
  maintainerEnabled: boolean;
  tuningEnabled: boolean;
  remoteDisabled?: boolean;
  onDevicesChange?: (enabled: boolean) => void;
  onMcpChange?: (enabled: boolean) => void;
  onHostingChange?: (enabled: boolean) => void;
  onMaintainerChange?: (enabled: boolean) => void;
  onTuningChange?: (enabled: boolean) => void;
}

export function ExperimentalSettingsView({
  devicesEnabled,
  mcpEnabled,
  hostingEnabled,
  maintainerEnabled,
  tuningEnabled,
  remoteDisabled = false,
  onDevicesChange,
  onMcpChange,
  onHostingChange,
  onMaintainerChange,
  onTuningChange,
}: ExperimentalSettingsViewProps): ReactElement {
  const { t } = useI18n();

  return (
    <SettingsStack>
      <DeviceExperimentCardView
        enabled={devicesEnabled}
        disabled={remoteDisabled}
        onChange={onDevicesChange}
      />
      <SettingsSection>
        <Setting
          toggle
          title={t("mcp.title")}
          description={t("mcp.experimentalEffect")}
        >
          <Switch
            aria-label={t("mcp.title")}
            checked={mcpEnabled}
            disabled={remoteDisabled}
            onCheckedChange={(checked) => onMcpChange?.(checked)}
          />
        </Setting>
        <Setting
          toggle
          title={t("hosting.feature")}
          description={t("hosting.featureDescription")}
        >
          <Switch
            aria-label={t("hosting.feature")}
            checked={hostingEnabled}
            onCheckedChange={(checked) => onHostingChange?.(checked)}
          />
        </Setting>
        <Setting
          toggle
          title={t("extras.maintainerMode")}
          description={t("extras.maintainerModeDescription")}
        >
          <Switch
            aria-label={t("extras.maintainerMode")}
            checked={maintainerEnabled}
            disabled={remoteDisabled}
            onCheckedChange={(checked) => onMaintainerChange?.(checked)}
          />
        </Setting>
      </SettingsSection>
      <SettingsSection>
        <Setting
          toggle
          title={t("topology.tuning")}
          description={t("topology.settingDescription")}
        >
          <Switch
            aria-label={t("topology.tuning")}
            checked={tuningEnabled}
            onCheckedChange={(checked) => onTuningChange?.(checked)}
          />
        </Setting>
      </SettingsSection>
    </SettingsStack>
  );
}

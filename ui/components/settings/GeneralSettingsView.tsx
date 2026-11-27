import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";
import { Button } from "../kit/button";
import { Field } from "../kit/field";
import { Input } from "../kit/input";
import { SegmentedControl } from "../kit/segmented-control";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { Switch } from "../kit/switch";
import {
  GeneralAppearanceSection,
  type AppPresenceMode,
  type GeneralAppearanceSectionProps,
  type ThemeColorSwatchOption,
  type ThemeMode,
  type TopologyMode,
} from "./GeneralAppearanceSection";
import { Setting, SettingsSection, SettingsStack } from "./SettingsRows";

export type {
  AppPresenceMode,
  ThemeColorSwatchOption,
  ThemeMode,
  TopologyMode,
};
export type DesktopRecoveryMode = "prompt" | "restart" | "independent";
export type ProxyMode = "system" | "direct" | "custom";

export interface GeneralSettingsViewProps
  extends GeneralAppearanceSectionProps {
  routingDelay: string;
  onRoutingDelayChange?: (value: string) => void;
  onRoutingDelayCommit?: (value: number, valid: boolean) => void;
  notificationsEnabled: boolean;
  onNotificationsEnabledChange?: (value: boolean) => void;
  autoOpenCodex: boolean;
  onAutoOpenCodexChange?: (value: boolean) => void;
  showDesktopRecovery?: boolean;
  desktopRecovery?: DesktopRecoveryMode;
  onDesktopRecoveryChange?: (value: DesktopRecoveryMode) => void;
  recoveryNotices?: ReactNode;
  taskApprovalEnabled: boolean;
  onTaskApprovalEnabledChange?: (value: boolean) => void;
  taskSettingsDisabled?: boolean;
  startAtLogin: boolean;
  startAtLoginDisabled?: boolean;
  onStartAtLoginChange?: (value: boolean) => void;
  showConnectionNotifications?: boolean;
  connectionNotifications?: boolean;
  onConnectionNotificationsChange?: (value: boolean) => void;
  language: string;
  onLanguageChange?: (value: string) => void;
  proxyMode: ProxyMode;
  proxyDisabled?: boolean;
  onProxyModeChange?: (value: ProxyMode) => void;
  proxyUrl?: string;
  proxyError?: string;
  onProxyUrlChange?: (value: string) => void;
  onProxySubmit?: () => void;
  storageSection?: ReactNode;
  aboutSection?: ReactNode;
}

export function GeneralSettingsView({
  routingDelay,
  onRoutingDelayChange,
  onRoutingDelayCommit,
  notificationsEnabled,
  onNotificationsEnabledChange,
  autoOpenCodex,
  onAutoOpenCodexChange,
  showDesktopRecovery = false,
  desktopRecovery = "prompt",
  onDesktopRecoveryChange,
  recoveryNotices,
  taskApprovalEnabled,
  onTaskApprovalEnabledChange,
  taskSettingsDisabled = false,
  startAtLogin,
  startAtLoginDisabled = false,
  onStartAtLoginChange,
  showConnectionNotifications = false,
  connectionNotifications = true,
  onConnectionNotificationsChange,
  language,
  onLanguageChange,
  proxyMode,
  proxyDisabled = false,
  onProxyModeChange,
  proxyUrl = "",
  proxyError = "",
  onProxyUrlChange,
  onProxySubmit,
  storageSection,
  aboutSection,
  ...appearanceProps
}: GeneralSettingsViewProps): ReactElement {
  const { t } = useI18n();
  const recoveryOptions: readonly {
    value: DesktopRecoveryMode;
    label: string;
  }[] = [
    { value: "prompt", label: t("desktopRecovery.prompt") },
    { value: "restart", label: t("desktopRecovery.restart") },
    { value: "independent", label: t("desktopRecovery.independent") },
  ];
  const recoveryLabel =
    recoveryOptions.find((option) => option.value === desktopRecovery)?.label ??
    recoveryOptions[0].label;

  return (
    <SettingsStack className="settings-page">
      <SettingsSection title={t("behavior")}>
        <Setting title={t("routing.delaySetting")} width={96}>
          <Input
            type="number"
            min={0}
            max={300}
            step={1}
            size="sm"
            aria-label={t("routing.delaySetting")}
            value={routingDelay}
            disabled={taskSettingsDisabled}
            inputClassName="tabular-nums"
            onChange={(event) => onRoutingDelayChange?.(event.target.value)}
            onBlur={(event) =>
              onRoutingDelayCommit?.(
                event.currentTarget.valueAsNumber,
                event.currentTarget.validity.valid,
              )
            }
          />
        </Setting>
        <Setting
          title={t("controlSourceNotifications")}
          description={t("controlSourceNotificationsDescription")}
          toggle
        >
          <Switch
            aria-label={t("controlSourceNotifications")}
            checked={notificationsEnabled}
            disabled={taskSettingsDisabled}
            onCheckedChange={(checked) =>
              onNotificationsEnabledChange?.(checked)
            }
          />
        </Setting>
        <Setting
          title={t("automaticallyOpenCodexTasks")}
          description={t("whenDisabledNewTasksRunInTheBackground")}
          toggle
        >
          <Switch
            aria-label={t("automaticallyOpenCodexTasks")}
            checked={autoOpenCodex}
            disabled={taskSettingsDisabled}
            onCheckedChange={(checked) => onAutoOpenCodexChange?.(checked)}
          />
        </Setting>
        {showDesktopRecovery && (
          <Setting title={t("desktopRecovery.setting")} width={236}>
            <Select
              value={desktopRecovery}
              disabled={taskSettingsDisabled}
              onValueChange={(next) => {
                if (next != null) {
                  onDesktopRecoveryChange?.(next as DesktopRecoveryMode);
                }
              }}
            >
              <SelectTrigger
                aria-label={t("desktopRecovery.setting")}
                className="w-full"
              >
                <SelectValue>{recoveryLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {recoveryOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Setting>
        )}
        {recoveryNotices && (
          <div className="grid gap-2 p-3">{recoveryNotices}</div>
        )}
        <Setting
          title={t("taskApprovalMode")}
          description={t("askForConfirmationByDefaultTheCloudCan")}
          toggle
        >
          <Switch
            aria-label={t("taskApprovalMode")}
            checked={taskApprovalEnabled}
            disabled={taskSettingsDisabled}
            onCheckedChange={(checked) => onTaskApprovalEnabledChange?.(checked)}
          />
        </Setting>
      </SettingsSection>

      <SettingsSection title={t("general")}>
        <Setting title={t("connectAtSystemSignIn")} toggle>
          <Switch
            aria-label={t("connectAtSystemSignIn")}
            checked={startAtLogin}
            disabled={startAtLoginDisabled}
            onCheckedChange={(checked) => onStartAtLoginChange?.(checked)}
          />
        </Setting>
        {showConnectionNotifications && (
          <Setting
            title={t("connectionNotifications")}
            description={t("connectionNotificationsDescription")}
            toggle
          >
            <Switch
              aria-label={t("connectionNotifications")}
              checked={connectionNotifications}
              onCheckedChange={(checked) =>
                onConnectionNotificationsChange?.(checked)
              }
            />
          </Setting>
        )}
        <Setting title={t("language")}>
          <SegmentedControl
            aria-label={t("language")}
            value={language}
            onValueChange={(next) => onLanguageChange?.(next)}
            options={[
              { value: "auto", label: t("system") },
              { value: "en", label: "English" },
              { value: "zh-CN", label: "简体中文" },
            ]}
          />
        </Setting>
      </SettingsSection>

      <GeneralAppearanceSection {...appearanceProps} />

      <SettingsSection title={t("network")}>
        <Setting
          title={t("proxy")}
          description={t("useTheSystemProxyOrAProxyJust")}
        >
          <SegmentedControl
            aria-label={t("proxyMode")}
            value={proxyMode}
            disabled={proxyDisabled}
            onValueChange={(next) => onProxyModeChange?.(next)}
            options={[
              { value: "system", label: t("systemProxy") },
              { value: "direct", label: t("noProxy") },
              { value: "custom", label: t("custom") },
            ]}
          />
        </Setting>
        {proxyMode === "custom" && (
          <div className="px-4 py-3">
            <Field id="proxy-url" label={t("proxyUrl")} error={proxyError}>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  onProxySubmit?.();
                }}
              >
                <Input
                  id="proxy-url"
                  value={proxyUrl}
                  onChange={(event) => onProxyUrlChange?.(event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  aria-invalid={!!proxyError}
                  aria-describedby={proxyError ? "proxy-url-error" : undefined}
                  disabled={proxyDisabled}
                  className="flex-1"
                />
                <Button type="submit" variant="primary" disabled={proxyDisabled}>
                  {t("save")}
                </Button>
              </form>
            </Field>
          </div>
        )}
      </SettingsSection>

      {storageSection}
      {aboutSection}
    </SettingsStack>
  );
}

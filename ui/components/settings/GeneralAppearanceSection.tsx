import { Eye, EyeOff } from "lucide-react";
import type { ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { RadioGroup, RadioSwatch } from "../kit/radio-group";
import { SegmentedControl } from "../kit/segmented-control";
import { Switch } from "../kit/switch";
import { Setting, SettingsSection } from "./SettingsRows";

export type AppPresenceMode = "all" | "menu" | "dock";
export type ThemeMode = "system" | "light" | "dark";
export type TopologyMode = "tree" | "flat";

export interface ThemeColorSwatchOption {
  value: string;
  label: string;
  swatch: string;
}

export interface GeneralAppearanceSectionProps {
  theme: ThemeMode;
  onThemeChange?: (value: ThemeMode) => void;
  themeColor: string;
  themeColorOptions: readonly ThemeColorSwatchOption[];
  onThemeColorChange?: (value: string) => void;
  showAppPresence?: boolean;
  appPresence?: AppPresenceMode;
  appPresenceDisabled?: boolean;
  onAppPresenceChange?: (value: AppPresenceMode) => void;
  topologyMode: TopologyMode;
  onTopologyModeChange?: (value: TopologyMode) => void;
  showUpstreamSources?: boolean;
  upstreamSources?: boolean;
  upstreamSourcesDisabled?: boolean;
  onUpstreamSourcesChange?: (value: boolean) => void;
  privateMode: boolean;
  onPrivateModeChange?: (hidden: boolean) => void;
}

export function GeneralAppearanceSection({
  theme,
  onThemeChange,
  themeColor,
  themeColorOptions,
  onThemeColorChange,
  showAppPresence = false,
  appPresence = "all",
  appPresenceDisabled = false,
  onAppPresenceChange,
  topologyMode,
  onTopologyModeChange,
  showUpstreamSources = false,
  upstreamSources = false,
  upstreamSourcesDisabled = false,
  onUpstreamSourcesChange,
  privateMode,
  onPrivateModeChange,
}: GeneralAppearanceSectionProps): ReactElement {
  const { t } = useI18n();

  return (
    <SettingsSection title={t("appearance")}>
      <Setting title={t("settings.theme")}>
        <SegmentedControl
          aria-label={t("settings.theme")}
          value={theme}
          onValueChange={(next) => onThemeChange?.(next)}
          options={[
            { value: "system", label: t("system") },
            { value: "light", label: t("light") },
            { value: "dark", label: t("dark") },
          ]}
        />
      </Setting>
      <Setting title={t("themeColor")}>
        <RadioGroup
          aria-label={t("themeColor")}
          value={themeColor}
          onValueChange={(next) => {
            if (typeof next === "string") onThemeColorChange?.(next);
          }}
          className="inline-flex flex-row items-center gap-0.5 rounded-popover border border-border bg-surface-subtle p-0.5"
        >
          {themeColorOptions.map((option) => (
            <RadioSwatch
              key={option.value}
              value={option.value}
              label={option.label}
              swatch={option.swatch}
            />
          ))}
        </RadioGroup>
      </Setting>
      {showAppPresence && (
        <Setting title={t("showAppIn")}>
          <SegmentedControl
            aria-label={t("showAppIn")}
            value={appPresence}
            disabled={appPresenceDisabled}
            onValueChange={(next) => onAppPresenceChange?.(next)}
            options={[
              { value: "all", label: t("all") },
              { value: "menu", label: t("menuBarOnly") },
              { value: "dock", label: t("dockOnly") },
            ]}
          />
        </Setting>
      )}
      <Setting title={t("topology.mode")}>
        <SegmentedControl
          aria-label={t("topology.mode")}
          value={topologyMode}
          onValueChange={(next) => onTopologyModeChange?.(next)}
          options={[
            { value: "tree", label: t("topology.tree") },
            { value: "flat", label: t("topology.flat") },
          ]}
        />
      </Setting>
      {showUpstreamSources && (
        <Setting title={t("homepage.upstreamSources")} toggle>
          <Switch
            aria-label={t("homepage.upstreamSources")}
            checked={upstreamSources}
            disabled={upstreamSourcesDisabled}
            onCheckedChange={(checked) => onUpstreamSourcesChange?.(checked)}
          />
        </Setting>
      )}
      <Setting title={t("accounts.privacy")}>
        <SegmentedControl
          aria-label={t("accounts.privacy")}
          value={privateMode ? "hidden" : "visible"}
          onValueChange={(next) => onPrivateModeChange?.(next === "hidden")}
          options={[
            {
              value: "visible",
              "aria-label": t("accounts.privacy.show"),
              label: (
                <Eye
                  size={15}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                  aria-hidden="true"
                />
              ),
            },
            {
              value: "hidden",
              "aria-label": t("accounts.privacy.hide"),
              label: (
                <EyeOff
                  size={15}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                  aria-hidden="true"
                />
              ),
            },
          ]}
        />
      </Setting>
    </SettingsSection>
  );
}

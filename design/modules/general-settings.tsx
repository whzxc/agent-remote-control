import { Frame } from "adg";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/kit/button";
import { GeneralSettingsView } from "@/components/settings/GeneralSettingsView";
import { StorageSettingsView } from "@/components/settings/StorageSettingsView";
import { UpdateAboutView } from "@/components/updates/UpdateAboutView";
import { LocaleProvider } from "@/i18n/react";
import { IconButton } from "../components/icon-button";
import { Panel } from "../components/panel";
import { copy as displayCopy } from "../fixtures/display-settings";
import { copy, palettes } from "../fixtures/general-settings";

export function ThemeSwatch({ value }: { value: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="8" fill={`var(--theme-swatch-${value}-left)`} />
      <path
        d="M8 0a8 8 0 0 1 0 16Z"
        fill={`var(--theme-swatch-${value}-right)`}
      />
    </svg>
  );
}

export function GeneralSettings({
  workspace = false,
}: { workspace?: boolean } = {}) {
  return (
    <Panel
      viewportHeight={workspace ? 800 : undefined}
      title={copy.text1}
      actions={<IconButton icon="maximize-2" label={copy.text2} />}
    >
      <GeneralSettingsContent />
    </Panel>
  );
}

export function GeneralSettingsContent() {
  return (
    <LocaleProvider locale="en">
      <GeneralSettingsView
        routingDelay={copy.text5}
        notificationsEnabled={false}
        autoOpenCodex={true}
        showDesktopRecovery={true}
        desktopRecovery="prompt"
        taskApprovalEnabled={true}
        startAtLogin={false}
        language="en"
        theme="light"
        themeColor={copy.text20}
        themeColorOptions={palettes.map(([value]) => ({
          value,
          label: value,
          swatch: `linear-gradient(90deg, var(--theme-swatch-${value}-left) 0% 50%, var(--theme-swatch-${value}-right) 50% 100%)`,
        }))}
        topologyMode="tree"
        privateMode={true}
        proxyMode="system"
        storageSection={
          <StorageSettingsView
            archiveDescription="120 hot files (1.4 MB); 52 to archive, 2 to compress losslessly."
            cleanupDescription="Archives: 480 KB · Expired outputs (>7d, deleted permanently): 1 (12.0 KB) · Legacy: 0 B."
            outputsMaxAgeDays={7}
            retention="0"
          />
        }
        aboutSection={
          <UpdateAboutView
            currentVersion="fixture"
            checkLabel={copy.text35}
            checkDisabled
            repositoryLabel={copy.text36}
            trailingNavSlot={
              <Button size="sm" variant="ghost">
                {copy.text38}
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  absoluteStrokeWidth
                  aria-hidden="true"
                />
              </Button>
            }
          />
        }
      />
    </LocaleProvider>
  );
}

export default () => [
  <Frame key="general-settings-content" name="general-settings-content" width={672}>
    <div className="w-full bg-surface-raised">
      <GeneralSettingsContent />
    </div>
  </Frame>,
  <Frame key="theme-swatch" name="theme-swatch" width={16}>
    <div className="flex w-full bg-surface-raised">
      <ThemeSwatch value={displayCopy.text40} />
    </div>
  </Frame>,
];

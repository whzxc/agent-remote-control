import { Frame } from "adg";
import { DisplaySettingsView } from "@/components/settings/DisplaySettingsView";
import { LocaleProvider } from "@/i18n/react";
import { Dialog } from "../components/panel";
import { copy } from "../fixtures/display-settings";

export function DisplayContent() {
  return (
    <LocaleProvider locale="en">
      <DisplaySettingsView
        layout="auto"
        maxVisibleAgents={4}
        quotaEnabled={false}
        quotaDisplay="remaining"
        resetDisplay="countdown"
        refreshMinutes={3}
      />
    </LocaleProvider>
  );
}

export function Display() {
  return (
    <Dialog viewportHeight={1080} title={copy.text39}>
      <DisplayContent />
    </Dialog>
  );
}

export default () => [
  <Frame key="display-content" name="display-content" width={672}>
    <div className="w-full bg-surface-raised">
      <DisplayContent />
    </div>
  </Frame>,
];

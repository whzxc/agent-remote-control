import { Frame } from "adg";
import {
  DeviceExperimentCardView,
  ExperimentalSettingsView,
} from "@/components/settings/ExperimentalSettingsView";
import { LocaleProvider } from "@/i18n/react";
import { IconButton } from "../components/icon-button";
import { Panel } from "../components/panel";
import type { DeviceLocale } from "../fixtures/device-link";
import { copy } from "../fixtures/experimental";

export function ExperimentalContent() {
  return (
    <LocaleProvider locale="en">
      <ExperimentalSettingsView
        devicesEnabled={false}
        mcpEnabled={false}
        hostingEnabled={false}
        maintainerEnabled={false}
        tuningEnabled={false}
      />
    </LocaleProvider>
  );
}

export function Experimental({
  workspace = false,
}: { workspace?: boolean } = {}) {
  return (
    <Panel
      viewportHeight={workspace ? 800 : undefined}
      leading={<IconButton icon="arrow-left" label={copy.text1} />}
      title={
        <>
          {copy.text2.split(" / ").map((part, index) => (
            <span key={part}>
              {index > 0 && <span aria-hidden="true"> / </span>}
              <span>{part}</span>
            </span>
          ))}
        </>
      }
      actions={<IconButton icon="maximize-2" label={copy.text3} />}
    >
      <ExperimentalContent />
    </Panel>
  );
}

type Localized = { locale: DeviceLocale };

export function DeviceExperiment({
  locale,
  enabled,
}: Localized & { enabled: boolean }) {
  return (
    <LocaleProvider locale={locale === "zh-CN" ? "zh-CN" : "en"}>
      <DeviceExperimentCardView enabled={enabled} />
    </LocaleProvider>
  );
}

const experimentalFrames = () => [
  <Frame key="experimental-content" name="experimental-content" width={672}>
    <div className="w-full bg-surface-raised">
      <ExperimentalContent />
    </div>
  </Frame>,
];

const deviceExperimentFrames = () =>
  [false, true].map((enabled) => (
    <Frame
      key={`device-experiment-${enabled ? "on" : "off"}`}
      name={`device-experiment-${enabled ? "on" : "off"}`}
      width={672}
      fixture={`device-experiment-${enabled ? "on" : "off"}-en@light`}
      capture={{ selector: ".device-experiment", viewport: "1280x800" }}
    >
      <DeviceExperiment locale="en" enabled={enabled} />
    </Frame>
  ));

export default () => [...experimentalFrames(), ...deviceExperimentFrames()];

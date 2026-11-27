import { copy, samples } from '../fixtures/general-settings';
import { copy as displayCopy } from '../fixtures/display-settings';
import { Frame } from "adg";
import { Panel } from "../components/panel";

import { SettingLine } from "../components/settings-row";
import { SingleChoice } from "../components/single-choice";
import { Switch } from "../components/switch";
import { Input } from "../components/field";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { UpdateAboutContent } from '../components/update-about';


import { SettingsChoices as Choices, SettingsGroup as Group, SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { behavior, palettes } from "../fixtures/general-settings";

export function ThemeSwatch({ value }: { value: string }) {
  return <svg width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="8" fill={`var(--theme-swatch-${value}-left)`} />
    <path d="M8 0a8 8 0 0 1 0 16Z" fill={`var(--theme-swatch-${value}-right)`} />
  </svg>;
}

export function GeneralSettings({ workspace = false }: { workspace?: boolean } = {}) {
  return (
    <Panel viewportHeight={workspace ? 800 : undefined}
      title={copy.text1}
      actions={<IconButton icon="maximize-2" label={copy.text2} />}
    >
      <GeneralSettingsContent />
    </Panel>
  );
}
export function GeneralSettingsContent() { return (<div className="flex flex-col gap-7 pt-2">
        <Group title={copy.text3}>
          <SettingLine title={copy.text4} className="py-3!">
            <Input value={copy.text5} className="w-[104px]" />
          </SettingLine>
          <ToggleRows rows={behavior.slice(0, 2)} />
          <SettingLine title="When Codex Desktop is unavailable">
            <Choices dropdown label="When Codex Desktop is unavailable" options={["Ask first", "Restart existing Desktop", "Launch an independent instance"]} value="Ask first" width={236} />
          </SettingLine>
          <ToggleRows rows={behavior.slice(2)} />
        </Group>
        <Group title={copy.text6}>
          <SettingLine title={copy.text7}>
            <Switch checked={false} label={copy.text8} />
          </SettingLine>
          <SettingLine title={copy.text9}>
            <Choices
              label={copy.text10}
              options={samples.sample11}
              value={copy.text12}
            />
          </SettingLine>
        </Group>
        <Group title={copy.text13}>
          <SettingLine title={copy.text14}>
            <Choices
              label={copy.text15}
              options={samples.sample16}
              value={copy.text17}
            />
          </SettingLine>
          <SettingLine title={copy.text18}>
            <SingleChoice
              label={copy.text19}
              value={copy.text20}
              iconOnly
              compact
              className="w-[198px]"
              options={palettes.map(([value]) => ({
                value,
                label: value,
                graphic: (
                  <ThemeSwatch value={value} />
                ),
              }))}
            />
          </SettingLine>
          <SettingLine title={copy.text21}>
            <Choices
              label={copy.text22}
              options={samples.sample23}
              width={180}
            />
          </SettingLine>
          <SettingLine title={copy.text24}>
            <SingleChoice
              label={copy.text25}
              value={copy.text26}
              iconOnly
              compact
              className="w-20"
              options={samples.sample27}
            />
          </SettingLine>
        </Group>
        <Group title={copy.text28}>
          <SettingLine
            title={copy.text29}
            description={samples.sample30}
            className="py-[23px]!"
          >
            <Choices
              label={copy.text31}
              options={samples.sample32}
              width={340}
            />
          </SettingLine>
        </Group>
        <Group title="Storage">
          <SettingLine title="Local state archiving" description="120 hot files (1.4 MB); 52 to archive, 2 to compress losslessly.">
            <Button variant="primary">Archive now</Button>
          </SettingLine>
          <SettingLine title="Archive retention" description="Applies only to compressed archives (archives/): older archives are permanently deleted during daily maintenance. Keep forever does not cover temporary outputs/ (files unmodified for over 7 days are permanently deleted during daily maintenance without archiving).">
            <Choices dropdown label="Archive retention" options={["Keep forever", "30 days", "90 days", "180 days"]} value="Keep forever" width={180} />
          </SettingLine>
          <SettingLine title="Clean up expired data and legacy directories" description="Archives: 480 KB · Expired outputs (>7d, deleted permanently): 1 (12.0 KB) · Legacy: 0 B.">
            <Button variant="secondary">Preview cleanup…</Button>
          </SettingLine>
        </Group>
        <UpdateAboutContent checkDisabled labels={{
          about: copy.text33,
          appVersion: copy.text34,
          check: copy.text35,
          repository: copy.text36,
          experimental: copy.text38,
          history: copy.updateHistory,
        }} />
      </div>); }
export default () => [
  <Frame name="general-settings-content" width={672}>
    <div className="w-full bg-surface-raised"><GeneralSettingsContent /></div>
  </Frame>,
  <Frame name="theme-swatch" width={16}>
    <div className="flex w-full bg-surface-raised"><ThemeSwatch value={displayCopy.text40} /></div>
  </Frame>,
];

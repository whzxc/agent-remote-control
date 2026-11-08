import { ThemeSwatch } from "./display-settings";
import { copy, samples } from '../fixtures/general-settings';
import { Frame, Icon } from "sdg";
import { Panel } from "../components/panel";

import { SettingLine } from "../components/settings-row";
import { SingleChoice } from "../components/single-choice";
import { Switch } from "../components/switch";
import { Input } from "../components/field";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";


import { SettingsChoices as Choices, SettingsGroup as Group, SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { behavior, palettes } from "../fixtures/general-settings";
export function GeneralSettings() {
  return (
    <Panel
      width={720}
      title={copy.text1}
      actions={<IconButton icon="maximize-2" label={copy.text2} />}
    >
      <GeneralSettingsContent />
    </Panel>
  );
}
export function GeneralSettingsContent() { return (<div class="flex flex-col gap-7 pt-2">
        <Group title={copy.text3}>
          <SettingLine title={copy.text4} class="py-3!">
            <Input value={copy.text5} class="w-[104px]" />
          </SettingLine>
          <ToggleRows rows={behavior} />
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
              class="w-[198px]"
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
              class="w-20"
              options={samples.sample27}
            />
          </SettingLine>
        </Group>
        <Group title={copy.text28}>
          <SettingLine
            title={copy.text29}
            description={samples.sample30}
            class="py-[23px]!"
          >
            <Choices
              label={copy.text31}
              options={samples.sample32}
              width={340}
            />
          </SettingLine>
        </Group>
        <div class="flex flex-col gap-[17px]">
          <Group title={copy.text33}>
            <SettingLine
              title={copy.text34}
              class="py-[15px]!"
            >
              <Button disabled class="opacity-45">{copy.text35}</Button>
            </SettingLine>
          </Group>
          <div class="flex items-center gap-3 px-4">
            <span class="text-meta text-text-secondary">{copy.text36}</span>
            <Button variant="ghost">{copy.text37}<Icon name="external-link" />
            </Button>
            <div class="ml-auto">
              <Button variant="ghost">{copy.text38}<Icon name="chevron-right" />
              </Button>
            </div>
          </div>
        </div>
      </div>); }
export default () => <Frame name="general-settings-content" width={672}>
  <div class="w-full bg-surface-raised"><GeneralSettingsContent /></div>
</Frame>;

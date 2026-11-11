import { copy, samples } from '../fixtures/display-settings';


import { SettingsChoices as Choices, SettingsGroup as Group } from "../components/settings-row";
import { Frame } from "adg";
import { Panel } from "../components/panel";

import { SettingLine } from "../components/settings-row";
import { Switch } from "../components/switch";

import { TaskBubble } from "../modules/task-presentation";

export function DisplayContent() {
  return (<div class="flex flex-col gap-[30px] pt-2">
        <Group title={copy.text1}>
          <div class="flex h-[124px] items-start justify-center pt-5 pr-9">
            <TaskBubble
              truncateHeadline={false}
              activityGap={8}
              title={copy.text2}
              duration={copy.text3}
              phase={copy.text4}
              headline={copy.text5}
              project={copy.text6}
              dispatch={samples.sample7}
            />
          </div>
          <SettingLine title={copy.text8}>
            <Choices
              label={copy.text9}
              options={samples.sample10}
              value={copy.text11}
            />
          </SettingLine>
          <SettingLine title={copy.text12}>
            <Choices
              label={copy.text13}
              options={samples.sample14}
              value={copy.text15}
            />
          </SettingLine>
          <SettingLine
            title={copy.text16}
            description={samples.sample17}
            class="pt-[17px]! pb-[9px]!"
          >
            <Switch checked label={copy.text18} />
          </SettingLine>
        </Group>
        <Group title={copy.text19}>
          <SettingLine title={copy.text20}>
            <Choices
              label={copy.text21}
              options={samples.sample22}
            />
          </SettingLine>
          <SettingLine title={copy.text23}>
            <Choices
              label={copy.text24}
              options={samples.sample25}
              value={copy.text26}
              width={200}
            />
          </SettingLine>
        </Group>
        <Group title={copy.text27}>
          <SettingLine title={copy.text28}>
            <Switch checked={false} label={copy.text29} />
          </SettingLine>
          <SettingLine title={copy.text30}>
            <Choices
              label={copy.text31}
              options={samples.sample32}
              width={220}
            />
          </SettingLine>
          <SettingLine title={copy.text33}>
            <Choices
              label={copy.text34}
              options={samples.sample35}
              dropdown
            />
          </SettingLine>
          <SettingLine title={copy.text36}>
            <Choices
              label={copy.text37}
              options={samples.sample38}
              value=""
            />
          </SettingLine>
        </Group>
      </div>);
}

export function Display() {
  return (
    <Panel width={720} title={copy.text39}>
      <DisplayContent  />
    </Panel>
  );
}
export function ThemeSwatch({ value }: { value: string }) { return (<svg width="16" height="16" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="8" fill={`var(--theme-swatch-${value}-left)`} />
                    <path d="M8 0a8 8 0 0 1 0 16Z" fill={`var(--theme-swatch-${value}-right)`} />
                  </svg>); }
export default () => [
  <Frame name="display-content" width={672}>
    <div class="w-full bg-surface-raised"><DisplayContent  /></div>
  </Frame>,
  <Frame name="theme-swatch" width={16}>
    <div class="flex w-full bg-surface-raised">
      <ThemeSwatch value={copy.text40} /></div>
  </Frame>,
];

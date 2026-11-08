import { GeneralSettings } from "../modules/general-settings";
import { SettingsChoices as Choices, SettingsGroup as Group, SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { SettingLine } from "../components/settings-row";

import { Switch } from "../components/switch";

import { IconButton } from "../components/icon-button";

import { BrandMark } from "../components/agent-icon";
import { TaskBubble } from "../modules/task-presentation";

const experiments = [
  {
    title: "MCP hub",
    description: [
      "Every control source reaches your MCP servers through ARC.",
      "Agents add and change servers.",
    ],
    checked: false,
  },
  {
    title: "Relay hosting",
    description: [
      "Show Relay hosting in the navigation capsule.",
      "Existing hosted relays keep running when this is off.",
    ],
    checked: false,
  },
  {
    title: "Maintainer mode",
    description: [
      "Include issue reporting and triage guidance",
      "in control-source guides.",
    ],
    checked: false,
  },
  {
    title: "Home topology tuning",
    description: [
      "Add topology controls to the navigation capsule.",
      "Saved adjustments stay active when this is off.",
    ],
    checked: false,
  },
  {
    title: "Pets",
    description: [
      "Show interactive pets on Home and choose",
      "a character for each node.",
    ],
    checked: false,
  },
  {
    title: "Studio display",
    description: [
      "Show the date, time and task activity with day and night",
      "lighting and full-screen controls.",
    ],
    checked: false,
  },
];


function Agents() {
  return (
    <Panel
      width={720}
      title="Agents"
      actions={<IconButton icon="refresh-cw" label="Refresh" />}
    >
      <div class="flex flex-col gap-[11px]">
        <div class="flex h-[33px] items-center gap-[6px]">
          <h3 class="mr-[13px] text-small font-[650] text-text-secondary">
            Installed
          </h3>
          <IconButton icon="gauge" label="Quota" />
          <IconButton icon="settings" label="Agent settings" />
        </div>
        <Card padded>
          <div class="flex items-center gap-4 py-2">
            <BrandMark brand="codex" size={40} />
            <div class="flex flex-col gap-[6px]">
              <strong class="text-body leading-4 font-[650]">Codex</strong>
              <span class="text-meta leading-4 text-text-secondary">
                fixture · Ready
              </span>
            </div>
            <div class="ml-auto">
              <Switch checked label="Codex" />
            </div>
          </div>
        </Card>
      </div>
    </Panel>
  );
}
function AgentDetail() {
  return (
    <Panel width={720} headerless>
      <header class="flex h-[46px] items-start justify-between gap-4">
        <div class="flex items-start gap-3 pt-[3px]">
          <BrandMark brand="codex" size={40} />
          <div class="flex flex-col gap-1 pt-[2px]">
            <h2 class="text-title leading-6 font-[650]">Codex</h2>
            <div class="flex gap-4 text-meta leading-4 font-normal">
              <span class="text-text-secondary">fixture</span>
              <span class="text-small text-accent-text">Official setup</span>
            </div>
          </div>
        </div>
        <IconButton icon="x" label="Close" />
      </header>
      <div class="pt-4">
        <Group title="Codex dispatch defaults">
          <SettingLine title="Model and effort" class="py-[6px]! min-h-[54px]!">
            <Choices
              label="Model and effort"
              options={["Agent default"]}
              width={360}
              dropdown
            />
          </SettingLine>
        </Group>
      </div>
    </Panel>
  );
}
function Display() {
  return (
    <Panel width={720} title="Agent settings">
      <div class="flex flex-col gap-[30px] pt-2">
        <Group title="Task bubbles">
          <div class="flex h-[124px] items-start justify-center pt-5 pr-9">
            <TaskBubble
              truncateHeadline={false}
              activityGap={8}
              title="Check project changes"
              duration="1:23"
              phase="Running command"
              headline="npm run check"
              project="arc"
              dispatch={{
                width: 128,
                model: "GPT-6.1 Sol",
                effort: "High reasoning effort",
                tier: "Fast",
                position: { count: 4, index: 2 },
                fast: true,
              }}
            />
          </div>
          <SettingLine title="Content density">
            <Choices
              label="Content density"
              options={["Compact", "Standard", "Detailed"]}
              value="Standard"
            />
          </SettingLine>
          <SettingLine title="Width">
            <Choices
              label="Width"
              options={["Narrow", "Medium", "Wide"]}
              value="Medium"
            />
          </SettingLine>
          <SettingLine
            title="Compact when crowded"
            description={[
              "Reduce density by one level when an",
              "Agent has more than 4 tasks.",
            ]}
            class="pt-[17px]! pb-[9px]!"
          >
            <Switch checked label="Compact when crowded" />
          </SettingLine>
        </Group>
        <Group title="Homepage Agents">
          <SettingLine title="Layout">
            <Choices
              label="Layout"
              options={["Auto", "Landscape", "Portrait"]}
            />
          </SettingLine>
          <SettingLine title="Maximum visible Agents">
            <Choices
              label="Maximum visible Agents"
              options={["4", "6", "8", "10"]}
              value="4"
              width={200}
            />
          </SettingLine>
        </Group>
        <Group title="Quota">
          <SettingLine title="Quota monitoring">
            <Switch checked={false} label="Quota monitoring" />
          </SettingLine>
          <SettingLine title="Quota display">
            <Choices
              label="Quota display"
              options={["Remaining", "Used"]}
              width={220}
            />
          </SettingLine>
          <SettingLine title="Exhaustion time display">
            <Choices
              label="Exhaustion time display"
              options={["Time until reset"]}
              dropdown
            />
          </SettingLine>
          <SettingLine title="Quota auto-refresh">
            <Choices
              label="Quota auto-refresh"
              options={["1 min", "3 min", "5 min", "10 min"]}
              value=""
            />
          </SettingLine>
        </Group>
      </div>
    </Panel>
  );
}
function Experimental() {
  return (
    <Panel
      width={720}
      title={
        <div class="flex items-center gap-[6px]">
          <IconButton icon="arrow-left" label="Back" />
          Settings / Experimental
        </div>
      }
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <div class="flex flex-col gap-6 pt-2">
        {[experiments.slice(0, 3), experiments.slice(3)].map((rows) => (
          <Card class="gap-0! py-0!">
            <ToggleRows rows={rows} />
          </Card>
        ))}
      </div>
    </Panel>
  );
}
const frames = [
  {
    name: "about",
    fixture: "settings-about-light",
    capture: { region: "Settings", viewport: "1280x1600" },
    note: "Full-content drawing can exceed the scroll viewport; inspect remaining scroll content during browser acceptance.",
    view: GeneralSettings,
  },
  {
    name: "agents",
    fixture: "agent-settings-dispatch-defaults",
    capture: {
      region: "Agents",
      viewport: "1280x800",
      clicks: ["Manage Agents"],
    },
    view: Agents,
  },
  {
    name: "agent-detail",
    fixture: "agent-settings-dispatch-defaults",
    capture: {
      region: "Codex",
      viewport: "1280x800",
      clicks: ["Manage Agents", "Codex"],
    },
    view: AgentDetail,
  },
  {
    name: "display",
    fixture: "agent-settings-display-light",
    capture: {
      region: "Agent settings",
      viewport: "1280x1080",
      clicks: ["Manage Agents", "Agent settings"],
    },
    note: "Full-content drawing can exceed the scroll viewport; inspect remaining scroll content during browser acceptance.",
    view: Display,
  },
  {
    name: "experimental",
    fixture: "experimental-settings",
    capture: { region: "Settings", viewport: "1280x800" },
    view: Experimental,
  },
];
export default () =>
  frames.map(({ view: View, ...frame }) => (
    <Frame {...frame}>
      <View />
    </Frame>
  ));

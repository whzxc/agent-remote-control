import { Frame, Icon } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { SettingLine } from "../components/settings-row";
import { SingleChoice } from "../components/single-choice";
import { Switch } from "../components/switch";
import { Input } from "../components/field";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { BrandMark } from "../components/agent-icon";
import { TaskBubble } from "../components/task-bubble";
const behavior = [
  {
    title: "Wake control sources",
    description: [
      "Send task status notifications to bound control sources.",
      "Inboxes remain available when disabled.",
    ],
    checked: false,
  },
  {
    title: "Automatically open Codex tasks",
    description: ["When enabled, new tasks open automatically in Codex."],
    checked: true,
  },
  {
    title: "Task approval mode",
    description: [
      "Task requests require local confirmation by default.",
      "Cloud requests can explicitly bypass confirmation.",
    ],
    checked: true,
  },
];
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
const palettes = [
  ["default", "#5B5FF5", "#5B5FF5"],
  ["blue", "#00a6c7", "#007aff"],
  ["purple", "#f8509e", "#943d96"],
  ["orange", "#e1393e", "#f78218"],
  ["green", "#e0b219", "#22b85c"],
];
function Choices({
  label,
  options,
  value = options[0],
  width = 300,
  dropdown = false,
}: {
  label: string;
  options: string[];
  value?: string;
  width?: number;
  dropdown?: boolean;
}) {
  return (
    <div style={{ width }}>
      <SingleChoice
        label={label}
        value={value}
        options={options.map((text) => ({ value: text, label: text }))}
        fill
        dropdown={dropdown}
      />
    </div>
  );
}
function Group({ title, children }: { title: string; children?: unknown }) {
  return (
    <section class="flex flex-col gap-3">
      <h3 class="text-small leading-4 font-[650] text-text-secondary">
        {title}
      </h3>
      <Card class="py-0! gap-0!">{children}</Card>
    </section>
  );
}
function ToggleRows({ rows }: { rows: typeof behavior }) {
  return (
    <>
      {rows.map((row) => (
        <SettingLine {...row}>
          <Switch checked={row.checked} label={row.title} />
        </SettingLine>
      ))}
    </>
  );
}
function About() {
  return (
    <Panel
      width={720}
      title="Settings"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <div class="flex flex-col gap-7 pt-2">
        <Group title="Behavior">
          <SettingLine title="Request routing delay (0–300 s)" class="py-3!">
            <Input value="15" class="w-[104px]" />
          </SettingLine>
          <ToggleRows rows={behavior} />
        </Group>
        <Group title="General">
          <SettingLine title="Start automatically at sign-in">
            <Switch checked={false} label="Start automatically at sign-in" />
          </SettingLine>
          <SettingLine title="Language">
            <Choices
              label="Language"
              options={["System", "English", "简体中文"]}
              value="English"
            />
          </SettingLine>
        </Group>
        <Group title="Appearance">
          <SettingLine title="Theme">
            <Choices
              label="Theme"
              options={["System", "Light", "Dark"]}
              value="Light"
            />
          </SettingLine>
          <SettingLine title="Theme color">
            <SingleChoice
              label="Theme color"
              value="default"
              iconOnly
              compact
              class="w-[198px]"
              options={palettes.map(([value, left, right]) => ({
                value,
                label: value,
                graphic: (
                  <svg data-brand width="16" height="16" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="8" fill={left} />
                    <path d="M8 0a8 8 0 0 1 0 16Z" fill={right} />
                  </svg>
                ),
              }))}
            />
          </SettingLine>
          <SettingLine title="Topology layout">
            <Choices
              label="Topology layout"
              options={["Tree", "Flat"]}
              width={180}
            />
          </SettingLine>
          <SettingLine title="Privacy mode">
            <SingleChoice
              label="Privacy mode"
              value="masked"
              iconOnly
              compact
              class="w-20"
              options={[
                { value: "visible", label: "Visible", icon: "eye" },
                { value: "masked", label: "Masked", icon: "eye-off" },
              ]}
            />
          </SettingLine>
        </Group>
        <Group title="Network">
          <SettingLine
            title="Proxy"
            description={[
              "Use the system proxy or configure",
              "a proxy just for ARC.",
            ]}
            class="py-[23px]!"
          >
            <Choices
              label="Proxy"
              options={["System proxy", "No proxy", "Custom"]}
              width={340}
            />
          </SettingLine>
        </Group>
        <div class="flex flex-col gap-[17px]">
          <Group title="About">
            <SettingLine
              title="Agent Remote Control vfixture"
              class="py-[15px]!"
            >
              <Button disabled class="opacity-45">
                Check for updates
              </Button>
            </SettingLine>
          </Group>
          <div class="flex items-center gap-3 px-4">
            <span class="text-meta text-text-secondary">
              whzxc/agent-remote-control
            </span>
            <Button variant="ghost">
              GitHub <Icon name="external-link" />
            </Button>
            <div class="ml-auto">
              <Button variant="ghost">
                Experimental <Icon name="chevron-right" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
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
    view: About,
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

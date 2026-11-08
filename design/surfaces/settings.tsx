
import { Display } from '../modules/display-settings';
import { Agents, AgentDetail } from "../modules/agent-settings";


import { GeneralSettings } from "../modules/general-settings";
import { SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";




import { IconButton } from "../components/icon-button";




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

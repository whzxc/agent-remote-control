
import { Experimental } from '../modules/experimental';

import { Display } from '../modules/display-settings';
import { Agents, AgentDetail } from "../modules/agent-settings";


import { GeneralSettings } from "../modules/general-settings";

import { Frame } from "adg";


















const frames = [
  {
    name: "about",
    fixture: "settings-about-light",
    capture: { selector: ".layer-panel", viewport: "1280x800" },
    note: "The body scrolls at the viewport cap while the header remains fixed.",
    view: GeneralSettings,
  },
  {
    name: "agents",
    fixture: "agent-settings-dispatch-defaults",
    capture: {
      selector: ".layer-panel",
      viewport: "1280x800",
      clicks: ["Manage Agents"],
    },
    view: Agents,
  },
  {
    name: "agent-detail",
    fixture: "agent-settings-dispatch-defaults",
    capture: {
      selector: ".layer-dialog:has(.agent-summary)",
      viewport: "1280x800",
      clicks: ["Manage Agents", "Codex"],
    },
    view: AgentDetail,
  },
  {
    name: "display",
    fixture: "agent-settings-display-light",
    capture: {
      selector: ".layer-dialog:has(.display-settings)",
      viewport: "1280x1080",
      clicks: ["Manage Agents", "Agent settings"],
    },
    note: "The body scrolls at the viewport cap while the header remains fixed.",
    view: Display,
  },
  {
    name: "experimental",
    fixture: "experimental-settings",
    capture: { selector: ".layer-panel", viewport: "1280x800" },
    view: Experimental,
  },
];
export default () =>
  frames.map(({ view: View, ...frame }) => {
    const workspace = ["about", "agents", "experimental"].includes(frame.name);
    return <Frame {...frame}>
      <View {...(workspace ? { workspace: true } : {})} />
    </Frame>;
  });

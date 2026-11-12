
import { Experimental } from '../modules/experimental';

import { Display } from '../modules/display-settings';
import { Agents, AgentDetail } from "../modules/agent-settings";


import { GeneralSettings } from "../modules/general-settings";

import { Frame } from "adg";


















const frames = [
  {
    name: "about",
    fixture: "settings-about-light",
    capture: { region: "Settings", viewport: "1280x800" },
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
  frames.map(({ view: View, ...frame }) => {
    const workspace = ["about", "agents", "experimental"].includes(frame.name);
    return <Frame {...frame} {...(workspace ? { width: 1280, height: 800 } : {})}>
      <View {...(workspace ? { workspace: true } : {})} />
    </Frame>;
  });

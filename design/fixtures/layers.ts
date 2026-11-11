import type { Scene } from "../modules/homepage-topology";
import { scenes } from "./topology";
import { centeredAgentPanelScenes } from "./agent-panel-topology";
import { copy } from "./general-settings";

export const aboutLabels = {
  about: copy.text33, appVersion: copy.text34, check: copy.text35,
  repository: copy.text36, experimental: copy.text38, history: copy.updateHistory,
};
export const layerCopy = {
  settings: copy.text1, expand: copy.text2,
  confirmation: "Reset settings?",
  consequence: "Your preferences will return to their defaults.",
  cancel: "Cancel", reset: "Reset settings", agent: "Codex",
};
export const dismissalCopy = {
  title: "Edit connection", field: "Name", value: "Studio",
  discard: "Discard your changes?", discardAction: "Discard", keep: "Keep editing",
  cancellable: "Saving connection…", stop: "Stop and close",
  running: "Saving connection… This dialog will close when the work finishes.",
};
export const dismissalForms = [
  { name: "dialog-discard", state: "discard", note: "Footer actions are replaced; Keep editing is focused and primary." },
  { name: "dialog-running-cancellable", state: "cancellable", note: "Footer actions are replaced; Stop and close cancels the work." },
  { name: "dialog-running", state: "running", note: "Non-cancellable work closes the dialog when finished." },
] as const;

export const workspaceScenes = {
  landscape: { ...scenes["empty-empty"], chrome: scenes["empty-empty"].chrome.filter(item => item.kind !== "button") },
  portrait: scenes["portrait-expanded-empty"],
};

// Reserve the fixed right slot. The selected node remains lower than the panel header.
export const fixedAgentScene: Scene = {
  ...centeredAgentPanelScenes.landscape,
  nodes: [[36, 370, 14], [140, 370, 13], [528, 280, 5], [528, 370, 11], [528, 460, 12]],
  links: [
    { d: "M87 394 H136 M191 394 Q228 394 250 400", class: "stroke-role-source/40", "stroke-width": "4" },
    { d: "M470 400 Q490 304 524 304 M470 400 Q495 394 524 394 M470 400 Q490 484 524 484 M552 332 V342 Q552 354 564 354 H704",
      class: "stroke-role-agent/45", "stroke-width": "4" },
    { d: "M258 359 A111 111 0 0 0 258 441", class: "stroke-role-source", "stroke-width": "10", "stroke-linecap": "round" },
    { d: "M462 359 A111 111 0 0 1 462 441", class: "stroke-role-agent", "stroke-width": "10", "stroke-linecap": "round" },
  ],
  mark: { x: 250, y: 290, size: 220, sourceAction: false, agentAction: false },
};

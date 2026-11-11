import type { Scene } from "../modules/homepage-topology";
import { scenes, nodes } from "./topology";
import { centeredAgentPanelScenes } from "./agent-panel-topology";
import { copy } from "./general-settings";

export const layerCopy = {
  settings: copy.text1, expand: copy.text2, relay: "Relay hosting",
  confirmation: "Reset settings?",
  consequence: "Your preferences will return to their defaults.",
  cancel: "Cancel", reset: "Reset settings", agent: "Codex",
};
export const dismissalCopy = {
  title: "Edit connection", field: "Name", value: "Studio",
  discard: "Discard your changes?", discardAction: "Discard", keep: "Keep editing",
  cancellable: "Saving connection… This dialog will close when the work finishes.",
  stop: "Stop and close", keepOpen: "Keep open",
  running: "Saving connection… This dialog will close when the work finishes.",
};
export const dismissalForms = [
  { name: "dialog-discard", state: "discard", note: "Footer actions are replaced; Keep editing is focused and primary." },
  { name: "dialog-running-cancellable", state: "cancellable",
    note: "Close is pending. Keep open is focused and primary. Stop and close cancels the work." },
  { name: "dialog-running", state: "running", note: "Close is pending. Keep open is focused and primary and withdraws the pending close." },
] as const;

export const workspaceScenes = {
  landscape: { ...scenes["empty-empty"], chrome: scenes["empty-empty"].chrome.filter(item => item.kind === "nav") },
  portrait: {
    ...scenes["portrait-expanded-empty"],
    chrome: scenes["portrait-expanded-empty"].chrome.filter(item => item.kind === "nav"),
  },
};

// The panel title retains the selected node's label while its wire occupies the outer side.
export const selectedAgentNode = { x: 528, y: 280, ...nodes[5] };

// Reserve the fixed right slot. The selected node remains lower than the panel header.
export const fixedAgentScene: Scene = {
  ...centeredAgentPanelScenes.landscape,
  nodes: [[36, 370, 14], [140, 370, 13], [528, 370, 11], [528, 460, 12]],
  links: [
    { d: "M87 394 H136 M191 394 Q228 394 250 400", class: "stroke-role-source/40", "stroke-width": "4" },
    { d: "M470 400 Q490 304 524 304 M470 400 Q495 394 524 394 M470 400 Q490 484 524 484",
      class: "stroke-role-agent/45", "stroke-width": "4" },
    // Sampled with the existing tentacle/end-tangent/taper geometry at the nearest panel edge point.
    { d:
      "M 704.0 303.0 L 700.4 303.0 L 696.9 303.0 L 693.5 303.0 L 690.2 303.0 L 686.9 303.0 L 683.8 302.9 L " +
      "680.8 302.9 L 677.8 302.9 L 674.9 302.9 L 672.1 302.9 L 669.3 302.9 L 666.6 302.8 L 664.0 302.8 L " +
      "661.5 302.8 L 659.0 302.8 L 656.5 302.8 L 654.1 302.7 L 651.8 302.7 L 649.5 302.7 L 647.2 302.7 L " +
      "645.0 302.7 L 642.8 302.6 L 640.6 302.6 L 638.5 302.6 L 636.4 302.6 L 634.3 302.6 L 632.2 302.5 L " +
      "630.2 302.5 L 628.1 302.5 L 626.1 302.5 L 624.0 302.5 L 622.0 302.4 L 620.0 302.4 L 617.9 302.4 L " +
      "615.9 302.4 L 613.8 302.3 L 611.8 302.3 L 609.7 302.3 L 607.6 302.3 L 605.4 302.2 L 603.2 302.2 L " +
      "601.0 302.1 L 598.8 301.9 L 596.5 301.6 L 594.2 301.0 L 591.9 300.4 L 589.5 299.5 L 587.0 298.5 L " +
      "587.0 309.5 L 589.5 308.5 L 591.9 307.6 L 594.2 307.0 L 596.5 306.4 L 598.8 306.1 L 601.0 305.9 L " +
      "603.2 305.8 L 605.4 305.8 L 607.6 305.7 L 609.7 305.7 L 611.8 305.7 L 613.8 305.7 L 615.9 305.6 L " +
      "617.9 305.6 L 620.0 305.6 L 622.0 305.6 L 624.0 305.5 L 626.1 305.5 L 628.1 305.5 L 630.2 305.5 L " +
      "632.2 305.5 L 634.3 305.4 L 636.4 305.4 L 638.5 305.4 L 640.6 305.4 L 642.8 305.4 L 645.0 305.3 L " +
      "647.2 305.3 L 649.5 305.3 L 651.8 305.3 L 654.1 305.3 L 656.5 305.2 L 659.0 305.2 L 661.5 305.2 L " +
      "664.0 305.2 L 666.6 305.2 L 669.3 305.1 L 672.1 305.1 L 674.9 305.1 L 677.8 305.1 L 680.8 305.1 L " +
      "683.8 305.1 L 686.9 305.0 L 690.2 305.0 L 693.5 305.0 L 696.9 305.0 L 700.4 305.0 L 704.0 305.0 Z",
      class: "fill-role-agent/55" },
    { d: "M 586.6 298.5 A 35 35 0 0 1 586.6 309.5", class: "stroke-role-agent", "stroke-width": "4.5" },
    { d: "M258 359 A111 111 0 0 0 258 441", class: "stroke-role-source", "stroke-width": "10", "stroke-linecap": "round" },
    { d: "M462 359 A111 111 0 0 1 462 441", class: "stroke-role-agent", "stroke-width": "10", "stroke-linecap": "round" },
  ],
  mark: { x: 250, y: 290, size: 220, sourceAction: false, agentAction: false },
  chrome: centeredAgentPanelScenes.landscape.chrome.map(item => item.kind === "board" ? { ...item, x: 240 } : item),
};

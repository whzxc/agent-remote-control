import type { Scene } from "../modules/homepage-topology";
import { scenes, nodes } from "./topology";
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

// The centered overlay leaves the configuration topology in place.
export const selectedAgentNode = { x: 836, y: 280, ...nodes[5] };
export const fixedAgentScene: Scene = { ...scenes["empty-empty"], tasks: [] };

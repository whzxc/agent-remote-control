import type { ScenePath } from "../modules/topology-scene";
export const sourceNodes = [
  { node: 1, x: 16, y: 64 },
  { node: 2, x: 16, y: 124 },
  { node: 3, x: 16, y: 184 },
  { node: 4, x: 16, y: 244 },
];
export const agentNodes = [
  { node: 5, x: 326, y: 451 },
  { node: 6, x: 326, y: 610 },
  { node: 7, x: 326, y: 682 },
];
export const tasks = [
  { title: "Inspect the dispatch queue", headline: "Reading queue state", y: 389 },
  { title: "Verify account attribution", headline: "Checking the workspace", y: 475 },
];
export { dispatch } from "./topology";
export const paths: readonly ScenePath[] = [
  { d: "M40 88V292Q40 316 64 316H158", class: "fill-none stroke-role-source/52", "stroke-width": "2" },
  { d: "M232 316H326Q350 316 350 340V706", class: "fill-none stroke-role-agent/52", "stroke-width": "2" },
  {
    d: "M350 475H330Q320 475 320 465V440Q320 432 308 432 M350 475H330Q320 475 320 485V510Q320 518 308 518",
    class: "fill-none stroke-role-agent/52",
    "stroke-width": "2",
  },
];

export const mobileCopy = {
  text2: "1:23",
  text3: "Running comm…",
  text4: "acceptance",
  text5: "Board",
};
export const mobileCopySamples = {
  sample1: {
    page: true,
    origin: "0 0",
    viewport: "390x844",
  },
};

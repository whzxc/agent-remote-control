import type { Scene } from "../modules/homepage-topology";
import { scenes } from "./topology";

const chrome = (scene: Scene): Scene["chrome"] => scene.chrome.flatMap<Scene["chrome"][number]>((item) => {
  if (item.kind === "board") return [{ ...item, date: "1月1日 · 周四", title: "公示牌" }];
  if (item.kind === "nav") return [{ ...item, active: "" }];
  return [];
});

export const centeredAgentPanelScenes: Record<"landscape" | "portrait", Scene> = {
  landscape: {
    nodes: [[69, 370, 14], [173, 370, 13], [748, 370, 5]],
    tasks: [],
    links: [
      { d: "M120 394 H169 M224 394 Q307 394 374 400", class: "stroke-role-source/40", "stroke-width": "4" },
      { d: "M594 400 Q668 394 744 394 M803 394 H844", class: "stroke-role-agent/45", "stroke-width": "4" },
      { d: "M382 359 A111 111 0 0 0 382 441", class: "stroke-role-source", "stroke-width": "10", "stroke-linecap": "round" },
      { d: "M586 359 A111 111 0 0 1 586 441", class: "stroke-role-agent", "stroke-width": "10", "stroke-linecap": "round" },
    ],
    mark: { x: 374, y: 290, size: 220, sourceAction: false, agentAction: false },
    chrome: chrome(scenes["empty-empty"]),
  },
  portrait: {
    nodes: [[24, 315, 13], [120, 315, 14], [568, 449, 5]],
    tasks: [],
    links: [
      { d: "M73 339 H119 M48 363 V386 Q48 412 74 412 H282", class: "stroke-role-source/52", "stroke-width": "2" },
      { d: "M358 412 H566 Q592 412 592 438 V449 M567 473 H531", class: "stroke-role-agent/52", "stroke-width": "2" },
    ],
    mark: { x: 282, y: 374, size: 76, sourceAction: false, agentAction: false },
    chrome: chrome(scenes["portrait-expanded-empty"]),
  },
};

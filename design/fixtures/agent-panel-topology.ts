import type { Scene } from "../modules/homepage-topology";
import { scenes } from "./topology";

const chrome = (scene: Scene): Scene["chrome"] => scene.chrome.flatMap<Scene["chrome"][number]>((item) => {
  if (item.kind === "board") return [{ ...item, date: "1月1日 · 周四", title: "公示牌" }];
  if (item.kind === "nav") return [{ ...item, active: "" }];
  return [];
});

export const centeredAgentPanelScenes: Record<"landscape" | "portrait", Scene & { dockCenter: number }> = {
  landscape: {
    dockCenter: 304,
    nodes: [[69, 370, 14], [173, 370, 13], [748, 280, 5], [748, 370, 11], [748, 460, 12]],
    tasks: [],
    links: [
      { d: "M120 394 H169 M224 394 Q307 394 374 400", class: "stroke-role-source/40", "stroke-width": "4" },
      { d: "M594 400 Q650 304 744 304 M594 400 Q667 394 744 394 M594 400 Q658 484 744 484 M803 304 H844", class: "stroke-role-agent/45", "stroke-width": "4" },
      { d: "M382 359 A111 111 0 0 0 382 441", class: "stroke-role-source", "stroke-width": "10", "stroke-linecap": "round" },
      { d: "M586 359 A111 111 0 0 1 586 441", class: "stroke-role-agent", "stroke-width": "10", "stroke-linecap": "round" },
    ],
    mark: { x: 374, y: 290, size: 220, sourceAction: false, agentAction: false },
    chrome: chrome(scenes["empty-empty"]),
  },
  portrait: {
    dockCenter: 396,
    nodes: [[24, 239, 13], [120, 239, 14], [568, 372, 5], [568, 449, 11], [568, 525, 12]],
    tasks: [],
    links: [
      { d: "M73 263 H119 M48 287 V310 Q48 336 74 336 H282", class: "stroke-role-source/52", "stroke-width": "2" },
      { d: "M358 336 H566 Q592 336 592 362 V549 M567 396 H531", class: "stroke-role-agent/52", "stroke-width": "2" },
    ],
    mark: { x: 282, y: 298, size: 76, sourceAction: false, agentAction: false },
    chrome: chrome(scenes["portrait-expanded-empty"]),
  },
};

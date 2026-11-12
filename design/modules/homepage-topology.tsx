import { Frame } from "adg";
import { TopologyScene, type ScenePath, type SceneItem } from "./topology-scene";
import { TopologyNode } from "./topology-node";
import { TopologyGroup } from "./topology-group";
import { TopologyMark } from "./topology-mark";
import { TaskBubble } from "../modules/task-presentation";
import { HomepageHeader, type HomepageMode } from "./homepage-mode";
import { BoardHeader } from "./board-header";
import { NavCapsule } from "./nav-capsule";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { nodes, groups, tasks, links, scenes, dispatch } from "../fixtures/topology";

type Placement = readonly [x: number, y: number, item: number];
type Chrome =
  | { kind: "board"; x: number; y: number; date: string; time: string; title: string; mode?: HomepageMode; attention?: number }
  | { kind: "nav"; x: number; y: number; active: string }
  | { kind: "button"; x: number; y: number; label: string; icon: string }
  | { kind: "icon"; x: number; y: number; icon: string };
export type Scene = {
  nodes: readonly Placement[];
  items?: readonly SceneItem[];
  groups?: readonly (readonly [x: number, y: number, group: number, anchor?: "right"])[];
  tasks: readonly Placement[];
  links: readonly (number | ScenePath)[];
  mark: Parameters<typeof TopologyMark>[0] & { x: number; y: number };
  chrome: readonly Chrome[];
};

export function TopologyScreen({
  width, height, scene, hideNodeLabels = false, children,
}: { width: number; height: number; scene: Scene; hideNodeLabels?: boolean; children?: unknown }) {
  const items = [
    ...(scene.items ?? []),
    ...scene.nodes.map(([x, y, node]) => ({
      x, y, content: <TopologyNode {...nodes[node]} hideLabel={hideNodeLabels || nodes[node].hideLabel} />,
    })),
    ...(scene.groups ?? []).map(([x, y, group, anchor]) => ({
      x, y, anchor, content: <TopologyGroup {...groups[group]} hideLabel={hideNodeLabels || groups[group].hideLabel} />,
    })),
    ...scene.tasks.map(([x, y, task]) => ({
      x, y, content: <TaskBubble {...tasks[task]} dispatch={dispatch} />,
    })),
    { x: scene.mark.x, y: scene.mark.y, content: <TopologyMark {...scene.mark} /> },
  ];
  return (
    <div class="relative bg-canvas" style={{ width, height }}>
      <TopologyScene width={width} height={height} items={items}
        paths={scene.links.map((link) => typeof link === "number" ? links[link] : link)} />
      <div data-free class="absolute inset-0">
        {scene.chrome.map((chrome) => (
          <div class="absolute flex" style={{ left: chrome.x, top: chrome.y }}>
            {chrome.kind === "board" ? (
              chrome.mode ? <HomepageHeader {...chrome} mode={chrome.mode} /> : <BoardHeader {...chrome} />
            ) : chrome.kind === "nav" ? (
              <NavCapsule active={chrome.active} />
            ) : chrome.kind === "button" ? (
              <Button icon={chrome.icon}>{chrome.label}</Button>
            ) : (
              <IconButton
                icon={chrome.icon}
                label={chrome.icon === "plus" ? "New task" : "Task history"}
                compact
                agent
              />
            )}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

export default () => (
  <Frame name="landscape" width={1280} height={800}>
    <TopologyScreen width={1280} height={800} scene={scenes["empty-empty"]} />
  </Frame>
);

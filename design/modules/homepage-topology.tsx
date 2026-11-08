import { Frame } from "sdg";
import { TopologyScene } from "./topology-scene";
import { TopologyNode } from "./topology-node";
import { TopologyMark } from "./topology-mark";
import { TaskBubble } from "../modules/task-presentation";
import { BoardHeader } from "./board-header";
import { NavCapsule } from "./nav-capsule";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { nodes, tasks, links, scenes, dispatch } from "../fixtures/topology";

type Placement = readonly [number, number, number];
type Chrome =
  | { kind: "board"; x: number; y: number; date: string; time: string; title: string }
  | { kind: "nav"; x: number; y: number; active: string }
  | { kind: "button"; x: number; y: number; label: string; icon: string }
  | { kind: "icon"; x: number; y: number; icon: string };
export type Scene = {
  nodes: readonly Placement[];
  tasks: readonly Placement[];
  links: readonly number[];
  mark: Parameters<typeof TopologyMark>[0] & { x: number; y: number };
  chrome: readonly Chrome[];
};

export function TopologyScreen({ width, height, scene }: { width: number; height: number; scene: Scene }) {
  const items = [
    ...scene.nodes.map(([x, y, node]) => ({ x, y, content: <TopologyNode {...nodes[node]} /> })),
    ...scene.tasks.map(([x, y, task]) => ({ x, y, content: <TaskBubble {...tasks[task]} dispatch={dispatch} /> })),
    { x: scene.mark.x, y: scene.mark.y, content: <TopologyMark {...scene.mark} /> },
  ];
  return (
    <div class="relative bg-canvas" style={{ width, height }}>
      <TopologyScene width={width} height={height} items={items} paths={scene.links.map((id) => links[id])} />
      <div data-free class="absolute inset-0">
        {scene.chrome.map((chrome) => (
          <div class="absolute flex" style={{ left: chrome.x, top: chrome.y }}>
            {chrome.kind === "board" ? (
              <BoardHeader {...chrome} />
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
    </div>
  );
}

export default () => (
  <Frame name="landscape" width={1280} height={800}>
    <TopologyScreen width={1280} height={800} scene={scenes["empty-empty"]} />
  </Frame>
);

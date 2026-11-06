import { TopologyScene } from "../components/topology-scene";
import { TopologyNode } from "../components/topology-node";
import { TopologyMark } from "../components/topology-mark";
import { TaskBubble } from "../components/task-bubble";
import { BoardHeader } from "../components/board-header";
import { NavCapsule } from "../components/nav-capsule";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { nodes, tasks, links } from "./topology";

type Placement = readonly [number, number, number];
type Chrome =
  | { kind: "board"; x: number; y: number; date: string; time: string; title: string }
  | { kind: "nav"; x: number; y: number; active: string }
  | { kind: "button"; x: number; y: number; label: string; icon: string }
  | { kind: "icon"; x: number; y: number; icon: string };
type Scene = {
  nodes: readonly Placement[];
  tasks: readonly Placement[];
  links: readonly number[];
  mark: Parameters<typeof TopologyMark>[0] & { x: number; y: number };
  chrome: readonly Chrome[];
};
const dispatch = { model: "GPT-6.1 Sol", effort: "High reasoning effort", position: { count: 4, index: 2 }, tier: "Fast", fast: true };

export function TopologyScreen({ width, height, scene }: { width: number; height: number; scene: Scene }) {
  const items = [
    ...scene.nodes.map(([x, y, node]) => ({ x, y, content: <TopologyNode {...nodes[node]} /> })),
    ...scene.tasks.map(([x, y, task]) => ({ x, y, content: <TaskBubble {...tasks[task]} dispatch={dispatch} /> })),
    { x: scene.mark.x, y: scene.mark.y, content: <TopologyMark {...scene.mark} /> },
  ];
  return <div class="relative bg-canvas" style={{ width, height }}>
    <TopologyScene width={width} height={height} items={items} paths={scene.links.map(id => links[id])} />
    <div data-free class="absolute inset-0">
      {scene.chrome.map(chrome => <div class="absolute flex" style={{ left: chrome.x, top: chrome.y }}>
        {chrome.kind === "board" ? <BoardHeader {...chrome} />
          : chrome.kind === "nav" ? <NavCapsule active={chrome.active} />
          : chrome.kind === "button" ? <Button icon={chrome.icon}>{chrome.label}</Button>
          : <IconButton icon={chrome.icon} label={chrome.icon === "plus" ? "New task" : "Task history"} compact agent />}
      </div>)}
    </div>
  </div>;
}

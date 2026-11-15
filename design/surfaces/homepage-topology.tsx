import { Frame } from "adg";
import { TopologyNode } from '../components/topology-node';
import { TopologyGroup } from '../components/topology-group';
import { TopologyMark } from '../components/topology-mark';
import { HomepageBar, type HomepageMode } from '../components/homepage-mode';
import { NavCapsule } from '../components/nav-capsule';
import { Button } from '../components/button';
import { IconButton } from '../components/icon-button';
import { nodes, groups, links, scenes } from '../fixtures/topology';


import { TopologyScene, type ScenePath, type SceneItem } from "../components/topology-scene";
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
    { x: scene.mark.x, y: scene.mark.y, content: <TopologyMark {...scene.mark} /> },
  ];
  return (
    <div class="relative bg-canvas" style={{ width, height }}>
      <TopologyScene width={width} height={height} items={items}
        paths={scene.links.map((link) => typeof link === "number" ? links[link] : link)} />
      <div data-free class="absolute inset-0">
        {scene.chrome.filter(chrome => chrome.kind !== "board").map((chrome) => (
          <div class="absolute flex" style={{ left: chrome.x, top: chrome.y }}>
            {chrome.kind === "nav" ? (
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
      <div class="absolute inset-x-6 top-12">
        {scene.chrome.filter(chrome => chrome.kind === "board").map(chrome =>
          chrome.kind === "board" && <HomepageBar {...chrome} mode={chrome.mode ?? "topology"} compact={width < 1000} />)}
      </div>
      {children}
    </div>
  );
}

const accountFrames = [
  {
    "name": "accounts",
    "width": 1280,
    "height": 800,
    "fixture": "topology-accounts",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "1280x800"
    },
    "scene": "accounts-accounts"
  },
  {
    "name": "dense",
    "width": 1280,
    "height": 800,
    "fixture": "topology-accounts-dense",
    "capture": { "page": true, "origin": "0 0", "viewport": "1280x800" },
    "scene": "accounts-dense"
  }
] as const;
const portraitFrames = [
  {
    "name": "expanded-empty",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-0",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-expanded-empty"
  },
  {
    "name": "sources-folded",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-sources-folded",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-sources-folded"
  },
  {
    "name": "agents-folded",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-agents-folded",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-agents-folded"
  },
] as const;
export default () => [
  <Frame name="empty" width={1280} height={800} fixture="connections-empty@light"
    capture={{ page: true, origin: "0 0", viewport: "1280x800" }}>
    <TopologyScreen width={1280} height={800} scene={scenes["empty-empty"]} />
  </Frame>,
  ...accountFrames.map(({ scene, ...frame }) => <Frame {...frame}>
    <TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} />
  </Frame>),
  ...portraitFrames.map(({ scene, ...frame }) => <Frame {...frame}>
    <TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} hideNodeLabels />
  </Frame>),
];

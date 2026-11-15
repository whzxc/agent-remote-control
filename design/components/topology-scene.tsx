import { TopologyNode } from '../components/topology-node';
import { TopologyGroup } from '../components/topology-group';
import { TopologyMark } from '../components/topology-mark';
import { HomepageBar, type HomepageMode } from '../components/homepage-mode';
import { NavCapsule } from '../components/nav-capsule';
import { Button } from '../components/button';
import { IconButton } from '../components/icon-button';
import { nodes, groups, links, scenes } from '../fixtures/topology';

import { example } from '../fixtures/topology-scene';
import { Frame } from "adg";

export type SceneItem = { x: number; y: number; anchor?: "right"; content: unknown };
export type SceneLink = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color?: string;
  controls?: readonly [{ x: number; y: number }, { x: number; y: number }];
};
export type ScenePath = {
  d: string;
  class: string;
  "stroke-width"?: string;
  "stroke-linecap"?: string;
  "stroke-linejoin"?: string;
};
/** Fixture coordinates only; runtime layout remains owned by solve.ts. */
export function TopologyScene({
  width,
  height,
  items = [],
  links = [],
  paths = [],
  children,
  transparent = false,
}: {
  width: number;
  height: number;
  items?: readonly SceneItem[];
  links?: readonly SceneLink[];
  paths?: readonly ScenePath[];
  children?: unknown;
  transparent?: boolean;
}) {
  return (
    <div data-free class={transparent ? "relative" : "relative bg-canvas"} style={{ width, height }}>
      {paths.length > 0 && (
        <svg class="absolute inset-0" width={width} height={height} fill="none">
          {paths.map((path) => (
            <path {...path} />
          ))}
        </svg>
      )}
      {links.length > 0 && (
        <svg class="absolute inset-0" width={width} height={height} fill="none" stroke-width="2">
          {links.map(({ from, to, color, controls }) => (
            <path
              d={
                "M" +
                String(from.x) +
                " " +
                String(from.y) +
                "C" +
                String(controls?.[0].x ?? (from.x + to.x) / 2) +
                " " +
                String(controls?.[0].y ?? from.y) +
                " " +
                String(controls?.[1].x ?? (from.x + to.x) / 2) +
                " " +
                String(controls?.[1].y ?? to.y) +
                " " +
                String(to.x) +
                " " +
                String(to.y)
              }
              stroke={color || "var(--role-agent)"}
            />
          ))}
        </svg>
      )}
      {items.map(({ x, y, anchor, content }) => (
        <div class="absolute" style={anchor === "right" ? { right: width - x, top: y } : { left: x, top: y }}>
          {content}
        </div>
      ))}
      {children}
    </div>
  );
}
export default () => <Frame name="default"><TopologyScene width={480} height={124} /></Frame>;
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


import { example } from "../fixtures/topology-scene";
import { Frame } from "adg";
import { BoardHeader } from "./board-header";

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
export default () => (
  <Frame name="default">
    <TopologyScene width={480} height={124} items={[{ x: 120, y: 27, content: <BoardHeader {...example} /> }]} />
  </Frame>
);

import { Frame } from "sdg";
import { BoardHeader } from "./board-header";
const example = {
  date: "1月1日 · 周四",
  time: "08:00",
  title: "公示牌",
  summary: "2 进行中",
};
export type SceneItem = { x: number; y: number; content: unknown };
export type SceneLink = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color?: string;
  controls?: readonly [{ x: number; y: number }, { x: number; y: number }];
};
/** Fixture coordinates only; runtime layout remains owned by solve.ts. */
export function TopologyScene({
  width,
  height,
  items = [],
  links = [],
  children,
}: {
  width: number;
  height: number;
  items?: readonly SceneItem[];
  links?: readonly SceneLink[];
  children?: unknown;
}) {
  return (
    <div data-free class="relative bg-canvas" style={{ width, height }}>
      {links.length > 0 && (
        <svg
          class="absolute inset-0"
          width={width}
          height={height}
          fill="none"
          stroke-width="2"
        >
          {links.map(({ from, to, color, controls }) => (
            <path
              d={`M${from.x} ${from.y}C${controls?.[0].x ?? (from.x + to.x) / 2} ${controls?.[0].y ?? from.y} ${controls?.[1].x ?? (from.x + to.x) / 2} ${controls?.[1].y ?? to.y} ${to.x} ${to.y}`}
              stroke={color || "var(--role-agent)"}
            />
          ))}
        </svg>
      )}
      {items.map(({ x, y, content }) => (
        <div class="absolute" style={{ left: x, top: y }}>
          {content}
        </div>
      ))}
      {children}
    </div>
  );
}
export default () => (
  <Frame name="default">
    <TopologyScene
      width={480}
      height={124}
      items={[{ x: 120, y: 27, content: <BoardHeader {...example} /> }]}
    />
  </Frame>
);

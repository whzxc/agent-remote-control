import { Frame, Icon } from "sdg";
import ClaudeCodeArt from "../art/claude-code.svg";
import CodexArt from "../art/codex.svg";
import OpenaiArt from "../art/openai.svg";
import AnthropicArt from "../art/anthropic.svg";
import GoogleArt from "../art/google.svg";
import XaiArt from "../art/xai.svg";
import MicrosoftArt from "../art/microsoft.svg";
import NotionArt from "../art/notion.svg";
import SlackArt from "../art/slack.svg";
import RaycastArt from "../art/raycast.svg";
import CursorArt from "../art/cursor.svg";
import OpencodeArt from "../art/opencode.svg";
import AlibabaArt from "../art/alibaba.svg";
import ClaudeArt from "../art/claude.svg";
import DeepseekArt from "../art/deepseek.svg";
import PiArt from "../art/pi.svg";
import AntigravityArt from "../art/antigravity.svg";
import { agentIconForms, iconExampleBrand } from "../fixtures/agent-icons";

const brands = {
  antigravity: AntigravityArt,
  claude: ClaudeArt,
  deepseek: DeepseekArt,
  pi: PiArt,
  "claude-code": ClaudeCodeArt,
  codex: CodexArt,
  openai: OpenaiArt,
  anthropic: AnthropicArt,
  google: GoogleArt,
  xai: XaiArt,
  microsoft: MicrosoftArt,
  notion: NotionArt,
  slack: SlackArt,
  raycast: RaycastArt,
  cursor: CursorArt,
  opencode: OpencodeArt,
  alibaba: AlibabaArt,
};
const arcs = {
  1: [[0, 360]],
  2: [
    [-8, -172],
    [8, 172],
  ],
  3: [
    [8, 112],
    [128, 232],
    [248, 352],
  ],
};
export type Brand = keyof typeof brands;
export type AgentIconReading = {
  id: string;
  label: string;
  value: number;
  color: string;
  elapsed?: number;
};
export function BrandMark({
  brand,
  size = 40,
}: {
  brand?: Brand;
  size?: number;
}) {
  const Artwork = brand && brands[brand];
  return (
    <span
      class="inline-flex shrink-0 items-center justify-center text-text"
      style={{ width: size, height: size }}
    >
      {Artwork ? (
        <Artwork data-brand width={size} height={size} />
      ) : (
        <Icon name="bot" size={size} />
      )}
    </span>
  );
}
function arcPath(start: number, end: number) {
  const point = (angle: number) => {
    const r = (angle * Math.PI) / 180;
    return `${24 + 21 * Math.sin(r)} ${24 - 21 * Math.cos(r)}`;
  };
  return end - start === 360
    ? "M24 3 A21 21 0 0 1 24 45 A21 21 0 0 1 24 3 Z"
    : `M${point(start)} A21 21 0 0 ${end > start ? 1 : 0} ${point(end)}`;
}
export function AgentIcon({
  brand,
  readings = [],
  used = false,
  size = 48,
}: {
  brand?: Brand;
  readings?: readonly AgentIconReading[];
  used?: boolean;
  size?: number;
}) {
  const ranges = arcs[readings.length as keyof typeof arcs];
  return (
    <span
      style={{ width: size, height: size }}
      class="grid shrink-0 place-items-center text-text"
      role="img"
      aria-label={readings.map((r) => r.label).join(" · ")}
    >
      {ranges && (
        <svg
          data-free
          class="col-start-1 row-start-1"
          width={size}
          height={size}
          viewBox="0 0 48 48"
          fill="none"
          stroke-width="3"
          stroke-linecap="round"
        >
          {ranges.map(([start, end], i) => {
            const reading = readings[i];
            const track = arcPath(start, end);
            return (
              <g>
                <path d={track} stroke="var(--border-strong)" />
                <path
                  d={
                    readings.length === 2 && !used ? arcPath(end, start) : track
                  }
                  pathLength="100"
                  stroke={reading.color}
                  stroke-dasharray={`${reading.value} 100`}
                />
                <path
                  d="M24 1V5"
                  transform={`rotate(${start + (end - start) * (reading.elapsed ?? 0)} 24 24)`}
                  stroke="var(--text-secondary)"
                  stroke-width="1.5"
                />
              </g>
            );
          })}
        </svg>
      )}
      <span class="col-start-1 row-start-1 flex">
        <BrandMark
          brand={brand}
          size={Math.round(((ranges ? 28 : 38) * size) / 48)}
        />
      </span>
    </span>
  );
}
export default () => [
  <Frame name="brand-mark">
    <BrandMark brand={iconExampleBrand} size={38} />
  </Frame>,
  ...agentIconForms.map(({ name, readings }) => (
    <Frame name={`agent-icon-${name}`}>
      <AgentIcon brand={iconExampleBrand} readings={readings} />
    </Frame>
  )),
];

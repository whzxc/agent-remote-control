import { Frame, Icon } from "sdg";
import ArcMarkArt from "../art/arc-mark.svg";
const forms = [
  { name: "default", lowerArcHover: false },
  { name: "lower-arc-hover", lowerArcHover: true },
];
const geometry = {
  size: 240,
  sourceX: 36.52,
  agentX: 203.48,
  centerY: 120,
  dotRadius: 3.91,
  dotGap: 15.65,
  powerY: 238,
};
export function TopologyMark({
  size = geometry.size,
  lowerArcHover = false,
}: {
  size?: number;
  lowerArcHover?: boolean;
}) {
  const g = geometry;
  return (
    <svg
      data-free
      width={size}
      height={lowerArcHover ? (size * 248) / 240 : size}
      viewBox={`0 0 240 ${lowerArcHover ? 248 : 240}`}
    >
      <ArcMarkArt
        data-brand
        width={240}
        height={240}
        style={{ "--lower-arc-offset": lowerArcHover ? "1.916667px" : "0px" }}
      />
      <g
        fill="none"
        stroke="var(--canvas)"
        stroke-width={7.82}
        stroke-linecap="round"
      >
        <path
          d={`M${g.sourceX - 9.333} ${g.centerY}h18.666M${g.sourceX} ${g.centerY - 9.333}v18.666`}
        />
      </g>
      {[-1, 0, 1].map((i) => (
        <circle
          cx={g.agentX + i * g.dotGap}
          cy={g.centerY}
          r={g.dotRadius}
          fill="var(--canvas)"
        />
      ))}
      {lowerArcHover && (
        <g>
          <circle cx={120} cy={g.powerY} r={10} fill="var(--role-agent)" />
          <g transform={`translate(113 ${g.powerY - 7})`} class="text-canvas">
            <Icon name="power" size={14} />
          </g>
        </g>
      )}
    </svg>
  );
}
export default () =>
  forms.map(({ name, ...props }) => (
    <Frame name={name}>
      <TopologyMark {...props} />
    </Frame>
  ));

import { Bot } from "lucide-react";

export type AgentIconReading = {
  id: string;
  label: string;
  value: number;
  color: string;
  elapsed?: number;
};

const arcs = {
  1: [[0, 360]],
  2: [[-8, -172], [8, 172]],
  3: [[8, 112], [128, 232], [248, 352]],
} as const;

function arcPath(start: number, end: number) {
  if (end - start === 360) return "M24 3 A21 21 0 0 1 24 45 A21 21 0 0 1 24 3 Z";
  const point = (degrees: number) => {
    const radians = degrees * Math.PI / 180;
    return `${24 + 21 * Math.sin(radians)} ${24 - 21 * Math.cos(radians)}`;
  };
  return `M${point(start)} A21 21 0 0 ${end > start ? 1 : 0} ${point(end)}`;
}

export function AgentIcon({ markup, readings = [], used = false }: {
  markup?: string;
  readings?: readonly AgentIconReading[];
  used?: boolean;
}) {
  const count = readings.length;
  const ranges = arcs[count as keyof typeof arcs];
  const label = readings.map(reading => reading.label).join(" · ") || undefined;
  return <span className={label ? "agent-quota-icon has-quota" : "agent-quota-icon"}
    role={label ? "img" : undefined} aria-label={label} title={label}>
    {ranges && <svg className="quota-outline" viewBox="0 0 48 48" aria-hidden="true">
      {ranges.map(([start, end], index) => {
        const { id, value, color, elapsed } = readings[index];
        const track = arcPath(start, end);
        const fill = count === 2 && !used ? arcPath(end, start) : track;
        const angle = start + (end - start) * (elapsed ?? 0);
        return <g key={id}>
          <path className="quota-track" d={track} />
          {value > 0 && <path d={fill} pathLength={100} stroke={color}
            strokeDasharray={value < 100 ? `${value} 100` : undefined} />}
          <path className="quota-time-tick" data-unknown={elapsed === undefined || undefined}
            d="M24 1V5" transform={`rotate(${angle} 24 24)`} />
        </g>;
      })}
    </svg>}
    {markup ? <span className="agent-logo" dangerouslySetInnerHTML={{ __html: markup }} aria-hidden="true" />
      : <Bot className="agent-logo" aria-hidden="true" />}
  </span>;
}

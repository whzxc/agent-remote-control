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

function arcPath(start: number, end: number, radius = 21) {
  const point = (degrees: number) => {
    const radians = degrees * Math.PI / 180;
    return `${24 + radius * Math.sin(radians)} ${24 - radius * Math.cos(radians)}`;
  };
  const sweep = end > start ? 1 : 0;
  const span = Math.abs(end - start);
  const command = `A${radius} ${radius} 0`;
  return span === 360
    ? `M${point(start)} ${command} 0 ${sweep} ${point(start + (end - start) / 2)} ${command} 0 ${sweep} ${point(start)} Z`
    : `M${point(start)} ${command} ${span > 180 ? 1 : 0} ${sweep} ${point(end)}`;
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
        const time = elapsed !== undefined && count === 1 && !used ? 1 - elapsed : elapsed ?? 0;
        const tick = start + (end - start) * time;
        const quotaEnd = start + (end - start) * value / 100;
        const pace = (used ? value : 100 - value) / 100 - (elapsed ?? 0);
        const showPace = count === 1 && elapsed !== undefined && Math.abs(pace) > Number.EPSILON;
        return <g key={id}>
          <path className="quota-track" d={track} />
          {value > 0 && <path d={fill} pathLength={100} stroke={color}
            strokeDasharray={value < 100 ? `${value} 100` : undefined} />}
          {showPace && <path d={arcPath(Math.min(tick, quotaEnd), Math.max(tick, quotaEnd), 17)}
            stroke={pace > 0 ? "var(--danger)" : "var(--success)"} strokeWidth={1.5} strokeDasharray="2 2.4" />}
          <path className="quota-time-tick" data-unknown={elapsed === undefined || undefined}
            d={showPace ? "M24 1V7" : "M24 1V5"} transform={`rotate(${tick} 24 24)`} />
        </g>;
      })}
    </svg>}
    {markup ? <span className="agent-logo" dangerouslySetInnerHTML={{ __html: markup }} aria-hidden="true" />
      : <Bot className="agent-logo" aria-hidden="true" />}
  </span>;
}

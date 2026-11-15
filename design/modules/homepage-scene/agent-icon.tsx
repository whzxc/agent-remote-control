import { type Brand, BrandMark } from '../../components/brand-mark';

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

export type AgentIconReading = {
  id: string;
  label: string;
  value: number;
  color: string;
  elapsed?: number;
};

function arcPath(start: number, end: number, radius = 21) {
  const point = (angle: number) => {
    const r = (angle * Math.PI) / 180;
    return `${24 + radius * Math.sin(r)} ${24 - radius * Math.cos(r)}`;
  };
  const sweep = end > start ? 1 : 0;
  const span = Math.abs(end - start);
  const command = `A${radius} ${radius} 0`;
  return span === 360
    ? `M${point(start)} ${command} 0 ${sweep} ${point(start + (end - start) / 2)} ${command} 0 ${sweep} ${point(start)} Z`
    : `M${point(start)} ${command} ${span > 180 ? 1 : 0} ${sweep} ${point(end)}`;
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
            const { value, color, elapsed } = readings[i];
            const track = arcPath(start, end);
            const single = readings.length === 1;
            const time = elapsed !== undefined && single && !used ? 1 - elapsed : elapsed ?? 0;
            const tick = start + (end - start) * time;
            const quotaEnd = start + (end - start) * value / 100;
            const pace = (used ? value : 100 - value) / 100 - (elapsed ?? 0);
            const showPace = single && elapsed !== undefined && Math.abs(pace) > Number.EPSILON;
            return (
              <g>
                <path d={track} stroke="var(--border-strong)" />
                <path
                  d={
                    readings.length === 2 && !used ? arcPath(end, start) : track
                  }
                  pathLength="100"
                  stroke={color}
                  stroke-dasharray={`${value} 100`}
                />
                {showPace && (
                  <path
                    d={arcPath(Math.min(tick, quotaEnd), Math.max(tick, quotaEnd), 17)}
                    stroke={pace > 0 ? "var(--danger)" : "var(--success)"}
                    stroke-width="1.5"
                    stroke-dasharray="2 2.4"
                  />
                )}
                <path
                  d={showPace ? "M24 1V7" : "M24 1V5"}
                  transform={`rotate(${tick} 24 24)`}
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

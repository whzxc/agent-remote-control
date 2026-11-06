const center = { x: 16, y: 17 };
const radius = 11.5;
const sweep = 260;
const needle = "M13.4433 16.1321 L16 8.6 L18.5567 16.1321 A2.7 2.7 0 1 1 13.4433 16.1321 Z";

function point(angle: number) {
  const radians = angle * Math.PI / 180;
  return [center.x + radius * Math.sin(radians), center.y - radius * Math.cos(radians)];
}

export type EffortPosition = { count: number; index: number };

export default function EffortGauge({ count, index }: EffortPosition) {
  const step = count > 1 ? sweep / (count - 1) : 0;
  // Keep the dots and rounded arcs separate when a catalog has many levels.
  const scale = Math.min(1, step ? step / 43 : 1);
  const stroke = 2.4 * scale;
  const stops = Array.from({ length: count }, (_, i) => {
    const angle = step ? -sweep / 2 + i * step : 0;
    const size = (i === index ? 2.35 : 1.65) * scale;
    const inset = 2 * Math.asin((size + stroke / 2 + .65 * scale) / (2 * radius)) * 180 / Math.PI;
    return { angle, size, inset };
  });
  return <svg className="effort-gauge" width="20" height="20" viewBox="0 0 32 32" focusable="false"
    aria-hidden="true">
    {stops.slice(1).map((stop, i) => {
      const previous = stops[i];
      const start = previous.angle + previous.inset, end = stop.angle - stop.inset;
      return <path key={stop.angle} d={`M${point(start).join(" ")} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end).join(" ")}`}
        fill="none" stroke={i < index ? "var(--role-agent)" : "var(--border-strong)"} strokeWidth={stroke} strokeLinecap="round" />;
    })}
    {stops.map((stop, i) => {
      const [cx, cy] = point(stop.angle);
      return <circle key={stop.angle} cx={cx} cy={cy} r={stop.size}
        fill={i <= index ? "var(--role-agent)" : "var(--text-tertiary)"} />;
    })}
    <path d={needle} transform={`rotate(${stops[index].angle} ${center.x} ${center.y})`} fill="var(--text)" />
  </svg>;
}

import "./Progress.css";
import { ProgressPrimitive } from "../kit/progress";

export function Progress({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root value={clamped} aria-label={label}>
      <ProgressPrimitive.Track className="progress">
        <ProgressPrimitive.Indicator
          style={{
            width: `${clamped}%`,
            background: color,
          }}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

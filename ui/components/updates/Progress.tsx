import './Progress.css';

import { Progress as R } from "radix-ui";

export function Progress({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}) {
  return (
    <R.Root
      className="progress"
      value={Math.max(0, Math.min(100, value))}
      aria-label={label}
    >
      <R.Indicator
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          background: color,
        }}
      />
    </R.Root>
  );
}

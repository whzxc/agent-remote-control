import { Frame } from "sdg";
import { BrandMark } from "./agent-icon";
import { IconButton } from "./icon-button";
const readings = [
  {
    label: "5h 额度",
    reset: "2h 0m",
    remaining: 27,
    estimate: "≈ 1h 7m",
    elapsed: 0.4,
  },
  {
    label: "周额度",
    reset: "3d 0h",
    remaining: 32,
    estimate: "≈ 1d 21h",
    elapsed: 3 / 7,
  },
];
const example = { title: "ChatGPT", updated: "2m ago" };
export function QuotaCard({ children }: { children?: unknown }) {
  return (
    <div class="flex w-full flex-col gap-5 rounded-card bg-surface-subtle px-4 pt-4 pb-[22px] text-text">
      {children}
    </div>
  );
}
export function QuotaDetailAction({ children }: { children?: unknown }) {
  return <span class="text-meta text-text-secondary">{children}</span>;
}
export function QuotaReading({
  label,
  reset,
  remaining,
  estimate,
  elapsed,
  used = false,
}: {
  label: string;
  reset: string;
  remaining: number;
  estimate: string;
  elapsed: number;
  used?: boolean;
}) {
  return (
    <div class="flex flex-col gap-2 text-meta leading-4">
      <div class="flex justify-between text-text-secondary">
        <span class="font-medium">{label}</span>
        <span>{reset}</span>
      </div>
      <div data-free class="relative h-[6px] mb-1 flex items-center">
        <div class="w-full h-[6px] rounded-[3px] bg-surface-sunken">
          <div
            style={{ width: `${remaining}%` }}
            class="h-full rounded-[3px] bg-warning"
          />
        </div>
        <span
          style={{ left: `calc(${elapsed * 100}% - 1px)` }}
          class="absolute w-[2px] h-[10px] rounded-[1px] bg-text-secondary"
        />
      </div>
      <div class="flex justify-between">
        <span>
          {used ? "已用" : "剩余"} {remaining}%
        </span>
        <span class="text-text-secondary">{estimate}</span>
      </div>
    </div>
  );
}
export default () => (
  <Frame name="default" width={392}>
    <QuotaCard>
      <header class="flex items-center gap-[10px] h-6">
        <BrandMark brand="codex" size={24} />
        <strong class="flex-1 text-body font-[650]">{example.title}</strong>
        <span class="text-meta text-text-tertiary">{example.updated}</span>
        <IconButton icon="refresh-cw" label="Refresh" compact />
      </header>
      <div class="flex flex-col gap-[26px]">
        {readings.map((reading) => (
          <QuotaReading {...reading} />
        ))}
      </div>
    </QuotaCard>
  </Frame>
);

import { Frame } from "sdg";
import { Card } from "../components/card";
import { quotaSpecimens } from "../fixtures/quota";

export type QuotaWindow = {
  label: string;
  value: number;
  mode: string;
  reset: string;
  elapsed?: number;
  tone: "success" | "warning" | "danger";
  detail?: string;
};

export function QuotaCard({ label, value, mode, reset, elapsed, tone, detail }: QuotaWindow) {
  const bar = { success: "bg-success", warning: "bg-warning", danger: "bg-danger" };
  const ink = { success: "text-text-secondary", warning: "text-warning", danger: "text-danger" };
  return (
    <Card padded class="gap-2!">
      <h3 class="text-meta leading-4 font-semibold text-text-secondary">{label}</h3>
      <div class="flex flex-wrap items-baseline gap-x-2 leading-7">
        <strong class="text-display font-[650] tabular-nums">{value}%</strong>
        <span class="text-meta text-text-secondary">{mode}</span>
      </div>
      <div data-free class="relative flex h-[6px] items-center rounded-[3px] bg-surface-sunken">
        <div style={{ width: `${value}%` }} class={`h-full rounded-[3px] ${bar[tone]}`} />
        {elapsed !== undefined && (
          <span
            style={{ left: `clamp(1px, ${elapsed * 100}%, calc(100% - 1px))` }}
            class="absolute h-[10px] w-[2px] rounded-[1px] bg-text-secondary"
          />
        )}
      </div>
      <div class="flex flex-wrap justify-between gap-x-2 gap-y-1 text-meta leading-4">
        <span class="text-text-secondary">{reset}</span>
        {detail && <span class={ink[tone]}>{detail}</span>}
      </div>
    </Card>
  );
}

export function QuotaCards({ windows }: { windows: readonly QuotaWindow[] }) {
  return (
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,164px),1fr))] gap-2">
      {windows.map(window => <QuotaCard {...window} />)}
    </div>
  );
}

export default () => quotaSpecimens.map(({ name, ...window }) => (
  <Frame name={`quota-card-${name}`} width={208}>
    <QuotaCard {...window} />
  </Frame>
));

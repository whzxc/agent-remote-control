import { Frame, Icon } from "adg";
import { Card } from './card';
import { quotaSpecimens } from '../fixtures/quota';

export type QuotaWindow = {
  label: string;
  value: number;
  mode: string;
  reset: string;
  elapsed?: number;
  projected?: number;
  tone: "success" | "warning" | "danger";
  detail?: string;
};

export type QuotaReading = Omit<QuotaWindow, "value" | "elapsed"> & {
  value: number | null;
};

function SegmentedQuotaTrack({ value, projected, tone }: QuotaReading) {
  const count = 36;
  const paint = { success: "bg-accent", warning: "bg-warning", danger: "bg-danger" }[tone];
  const solid = value === null ? 0 : Math.min(value, projected ?? value);
  const extent = value === null ? 0 : Math.max(value, projected ?? value);
  const segmentWidth = (percentage: number, index: number) =>
    `${Math.max(0, Math.min(1, (percentage / 100) * count - index)) * 100}%`;
  return (
    <div aria-hidden="true" class="grid min-w-0 gap-[2px]"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }} data-free>
      {Array.from({ length: count }, (_, index) => {
        const fill = segmentWidth(solid, index);
        const end = segmentWidth(extent, index);
        return (
          <span class="relative h-[11px] overflow-hidden rounded-full bg-surface-sunken">
            {end !== fill && <span class={`absolute inset-y-0 left-0 ${paint} opacity-30`} style={{ width: end }} />}
            {fill !== "0%" && <span class={`absolute inset-y-0 left-0 ${paint}`} style={{ width: fill }} />}
          </span>
        );
      })}
    </div>
  );
}

export function QuotaCard(window: QuotaReading) {
  const { label, value, mode, reset, tone, detail, projected } = window;
  const meta = detail ?? (projected === undefined ? undefined : `预计重置时${mode} ${projected}%`);
  const detailPaint = { success: "text-text-secondary", warning: "text-warning", danger: "text-danger" }[tone];
  return (
    <section class="grid min-w-0 gap-1 border-b border-border py-2.5 last:border-b-0">
      <div class="grid grid-cols-[minmax(min(7rem,45%),0.85fr)_minmax(0,1.15fr)] items-center gap-3">
        <h3 class="min-w-0 text-small font-semibold leading-5 break-words">{label}</h3>
        <SegmentedQuotaTrack {...window} />
      </div>
      <div class="flex items-baseline justify-between gap-2 text-meta leading-5 text-text-secondary">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span class="relative pl-[19px]">
            <span class="absolute top-1/2 left-0 -translate-y-1/2"><Icon name="history" size={13} /></span>
            {reset}
          </span>
          {meta && <span class={detailPaint}>· {meta}</span>}
        </div>
        <span class="inline-flex shrink-0 items-baseline gap-1.5">
          {mode}
          <strong class={`text-body font-[650] tabular-nums ${tone === "danger" ? "text-danger" : "text-text"}`}>
            {value === null ? "—" : value > 0 && value < 1 ? "<1%" : `${value}%`}
          </strong>
        </span>
      </div>
    </section>
  );
}

export function QuotaCards({ windows, heading }: { windows: readonly QuotaReading[]; heading?: unknown }) {
  return (
    <Card variant="reply" class="gap-0! border border-border px-3.5 py-0!">
      {heading}
      {windows.map(window => <QuotaCard {...window} />)}
    </Card>
  );
}

export default () => quotaSpecimens.map(({ name, ...window }) => (
  <Frame name={`quota-card-${name}`} width={300}>
    <QuotaCards windows={[window]} />
  </Frame>
));

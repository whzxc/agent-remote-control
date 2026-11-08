import { Frame } from "sdg";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { readings, quotaExample, agentQuotas, quotaAccounts } from "../fixtures/quota";

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
export function QuotaBar({
  remaining,
  elapsed,
  tone = "warning",
}: {
  remaining: number;
  elapsed?: number;
  tone?: "warning" | "accent";
}) {
  return (
    <div
      data-free
      class="relative flex h-[6px] items-center rounded-[3px] bg-surface-sunken"
    >
      <div
        style={{ width: `${remaining}%` }}
        class={`h-full rounded-[3px] ${tone === "accent" ? "bg-accent" : "bg-warning"}`}
      />
      {elapsed !== undefined && (
        <span
          style={{ left: `calc(${elapsed * 100}% - 1px)` }}
          class="absolute h-[10px] w-[2px] rounded-[1px] bg-text-secondary"
        />
      )}
    </div>
  );
}
export function QuotaSummary({
  label,
  remaining,
  estimate,
  elapsed,
  tall = false,
  tone = "warning",
}: {
  label: string;
  remaining: number;
  estimate?: string;
  elapsed?: number;
  tall?: boolean;
  tone?: "warning" | "accent";
}) {
  return (
    <div
      class={`flex min-w-0 flex-col rounded-card bg-surface-subtle px-4 pt-4 ${tall ? "pb-[18px]" : "pb-4"}`}
    >
      <span class="text-meta leading-4 font-medium text-text-secondary">
        {label}
      </span>
      <div
        class={`flex h-7 items-baseline gap-[10px] leading-7 ${tall ? "mt-3" : "mt-[10px]"}`}
      >
        <strong class="text-display font-[650]">{remaining}%</strong>
        {estimate && <span class="text-meta text-warning">{estimate}</span>}
      </div>
      <div class={tall ? "mt-4" : "mt-2"}>
        <QuotaBar remaining={remaining} elapsed={elapsed} tone={tone} />
      </div>
    </div>
  );
}

export default () => [
  <Frame name="quota-card" width={392}>
    <QuotaCard>
      <header class="flex items-center gap-[10px] h-6">
        <BrandMark brand="codex" size={24} />
        <strong class="flex-1 text-body font-[650]">{quotaExample.title}</strong>
        <span class="text-meta text-text-tertiary">{quotaExample.updated}</span>
        <IconButton icon="refresh-cw" label="Refresh" compact />
      </header>
      <div class="flex flex-col gap-[26px]">
        {readings.map((reading) => (
          <QuotaReading {...reading} />
        ))}
      </div>
    </QuotaCard>
  </Frame>,
  <Frame name="quota-reading" width={360}>
    <div class="w-full bg-surface-subtle"><QuotaReading {...readings[0]} /></div>
  </Frame>,
  <Frame name="quota-bar" width={360}>
    <div class="w-full bg-surface-subtle py-[2px]"><QuotaBar {...readings[0]} /></div>
  </Frame>,
  <Frame name="quota-summary" width={186}>
    <div class="w-full bg-surface-raised"><QuotaSummary {...agentQuotas[0]} /></div>
  </Frame>,
  <Frame name="quota-summary-tall" width={216}>
    <div class="w-full bg-surface-raised"><QuotaSummary {...quotaAccounts[0].quotas[0]} tall /></div>
  </Frame>,
  <Frame name="quota-detail-action">
    <QuotaDetailAction>{quotaExample.updated}</QuotaDetailAction>
  </Frame>,
];

import { Frame } from "sdg";
import { BrandMark, type Brand } from "../components/agent-icon";
import { forms } from "../fixtures/topology-group";

export type TopologyGroupQuota = "ok" | "low" | "out" | "unknown";
export type TopologyGroupMember = { brand: Brand; quota?: TopologyGroupQuota };
export type TopologyGroupProps = {
  label: string;
  members: readonly TopologyGroupMember[];
  layout?: "vertical" | "source" | "agent";
  hideLabel?: boolean;
};

const dot: Record<TopologyGroupQuota, string> = {
  ok: "bg-success",
  low: "bg-warning",
  out: "bg-danger",
  unknown: "bg-border-strong",
};

/**
 * A folded group of sibling nodes. The first mark is centered 24px from the
 * group's leading edge, on the same axis as a regular node's icon.
 */
export function TopologyGroup({ label, members, layout = "vertical", hideLabel = false }: TopologyGroupProps) {
  const brands = [...new Set(members.map((m) => m.brand))];
  const pool = brands.length === 1;
  const quotas = pool ? members.flatMap((m) => (m.quota ? [m.quota] : [])).slice(0, 12) : [];
  const capsule = (
    <span
      aria-label={hideLabel ? label : undefined}
      class={
        "flex h-10 shrink-0 items-center gap-2 rounded-full border border-border bg-surface pr-3 shadow-sm " +
        String(pool ? "pl-[9px]" : "pl-[8px]")
      }
    >
      {pool ? (
        <BrandMark brand={brands[0]} size={28} />
      ) : (
        <span class="flex">
          {brands.slice(0, 3).map((brand, i) => (
            <span
              class={
                "flex size-[30px] items-center justify-center rounded-full border border-border bg-surface " +
                String(i ? "-ml-[4px]" : "")
              }
            >
              <BrandMark brand={brand} size={18} />
            </span>
          ))}
        </span>
      )}
      {quotas.length > 0 && (
        <span class="grid grid-flow-col grid-rows-2 gap-[4px]">
          {quotas.map((q) => (
            <span class={"size-[6px] rounded-full " + dot[q]} />
          ))}
        </span>
      )}
      <span class="text-meta font-semibold tabular-nums text-text-secondary">{members.length}</span>
    </span>
  );
  if (hideLabel) return capsule;
  if (layout === "source")
    return (
      <div class="flex h-12 items-center gap-[5px] text-text">
        <span class="flex w-[85px] shrink-0 justify-end text-meta text-text-secondary">{label}</span>
        {capsule}
      </div>
    );
  if (layout === "agent")
    return (
      <div class="flex h-12 items-center gap-2 text-text">
        {capsule}
        <span class="whitespace-nowrap text-meta text-text-secondary">{label}</span>
      </div>
    );
  return (
    <div class="flex flex-col items-start gap-1 text-text">
      {capsule}
      <span class="pl-[6px] text-meta leading-5 text-text-secondary">{label}</span>
    </div>
  );
}

export default () =>
  forms.map(({ name, ...props }) => (
    <Frame name={name}>
      <TopologyGroup {...props} />
    </Frame>
  ));

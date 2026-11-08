import { Frame } from "sdg";
import { BrandMark, type Brand } from "../components/agent-icon";
import { forms } from "../fixtures/topology-group";

export type TopologyGroupQuota = "ok" | "low" | "out" | "unknown";
export type TopologyGroupMember = { brand: Brand; quota?: TopologyGroupQuota };
export type TopologyGroupProps = {
  label: string;
  members: readonly TopologyGroupMember[];
  layout?: "vertical" | "source" | "agent" | "account-branch";
  hideLabel?: boolean;
};

const dot: Record<TopologyGroupQuota, string> = {
  ok: "bg-success",
  low: "bg-warning",
  out: "bg-danger",
  unknown: "bg-border-strong",
};

/**
 * A folded group of sibling nodes. An account branch relies on its parent
 * node for brand identity.
 */
export function TopologyGroup({ label, members, layout = "vertical", hideLabel = false }: TopologyGroupProps) {
  const brands = [...new Set(members.map((m) => m.brand))];
  const pool = brands.length === 1;
  const accountBranch = layout === "account-branch";
  const quotas = pool ? members.flatMap((m) => (m.quota ? [m.quota] : [])).slice(0, 12) : [];
  const capsule = (
    <span
      role={accountBranch ? "img" : undefined}
      aria-label={hideLabel || accountBranch ? label : undefined}
      class={
        "flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface shadow-sm " +
        String(accountBranch ? "h-7 px-2" : pool ? "h-10 pl-[9px] pr-3" : "h-10 pl-2 pr-3")
      }
    >
      {accountBranch ? null : pool ? (
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
        <span class={"grid grid-flow-col gap-1 " + (accountBranch && quotas.length <= 6 ? "grid-rows-1" : "grid-rows-2")}>
          {quotas.map((q) => (
            <span class={(accountBranch ? "size-[5px]" : "size-[6px]") + " rounded-full " + dot[q]} />
          ))}
        </span>
      )}
      <span class="text-meta font-semibold tabular-nums text-text-secondary">{members.length}</span>
    </span>
  );
  if (hideLabel || accountBranch) return capsule;
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

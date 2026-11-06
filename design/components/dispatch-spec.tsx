import { Frame, Icon } from "sdg";
import { EffortGauge, type EffortPosition } from "./effort-gauge";
const example = {
  model: "GPT-5.6 Sol",
  effort: "Medium reasoning effort",
  position: { count: 3, index: 1 },
  tier: "Fast",
  fast: true,
};
export function DispatchSpec({
  id,
  model,
  effort,
  position,
  tier,
  fast,
}: {
  id?: string;
  model?: string;
  effort?: string;
  position?: EffortPosition;
  tier?: string;
  fast?: boolean;
}) {
  return (
    <span
      id={id}
      role="img"
      aria-label={[model, effort, tier].filter(Boolean).join(" · ")}
      class="inline-flex shrink-0 items-center gap-1 h-6 px-[9px] rounded-field bg-surface-sunken text-text text-meta font-semibold"
    >
      {model && <span>{model}</span>}
      {effort &&
        (position ? <EffortGauge {...position} /> : <span>{effort}</span>)}
      {tier &&
        (fast ? (
          <Icon name="zap" size={12} class="text-warning" />
        ) : (
          <span>{tier}</span>
        ))}
    </span>
  );
}
export default () => (
  <Frame name="standard">
    <DispatchSpec {...example} />
  </Frame>
);

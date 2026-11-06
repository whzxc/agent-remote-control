import { Frame } from "sdg";
const steps = ["Inherit", "Low", "Medium", "High", "Max"];
export function EffortSlider({
  steps,
  value,
  label,
  valueText,
  disabled,
}: {
  steps: readonly string[];
  value: number;
  label: string;
  valueText: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuetext={valueText}
      aria-valuenow={value}
      aria-disabled={disabled}
      class="grid w-full items-center h-9"
    >
      <span class="col-start-1 row-start-1 h-7 rounded-[14px] bg-surface-sunken" />
      <div class="col-start-1 row-start-1 flex justify-between px-4">
        {steps.map((step) => (
          <span
            title={step}
            class="size-[5px] rounded-[3px] bg-text-tertiary"
          />
        ))}
      </div>
      <div class="col-start-1 row-start-1 flex">
        <span
          style={{
            width: `calc((100% - 36px) * ${value / Math.max(1, steps.length - 1)})`,
          }}
        />
        <span class="size-9 rounded-card bg-knob shadow-md" />
      </div>
    </div>
  );
}
export default () => (
  <Frame name="stepped" width={280}>
    <EffortSlider steps={steps} value={0} label="Effort" valueText={steps[0]} />
  </Frame>
);

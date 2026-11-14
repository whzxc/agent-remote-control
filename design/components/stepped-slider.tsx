import { Frame } from "adg";

export function SteppedSlider({
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
      <span class="col-start-1 row-start-1 h-7 rounded-(--radius-pill) bg-surface-sunken" />
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
        <span class="size-9 rounded-full bg-knob shadow-md" />
      </div>
    </div>
  );
}

const steps = ["One", "Two", "Three", "Four", "Five"];

export default () => (
  <Frame name="stepped" width={280}>
    <SteppedSlider steps={steps} value={0} label="Level" valueText={steps[0]} />
  </Frame>
);

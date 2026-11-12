import { Frame, Icon } from "adg";
import { Dialog, PanelShell } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { IconButton } from "../components/icon-button";
import {
  dispatchExample, effortGaugeForms, effortSteps, sliderExample,
  modelExample, followModelOptions, pickerEffortSteps, modelOptions,
} from "../fixtures/model-configuration";

const center = { x: 16, y: 17 };
const radius = 11.5;
const sweep = 260;
const needle =
  "M13.4433 16.1321 L16 8.6 L18.5567 16.1321 A2.7 2.7 0 1 1 13.4433 16.1321 Z";

function point(angle: number) {
  const radians = (angle * Math.PI) / 180;
  return [
    center.x + radius * Math.sin(radians),
    center.y - radius * Math.cos(radians),
  ];
}

export type EffortPosition = { count: number; index: number };

export function EffortGauge({
  count,
  index,
  size = 20,
}: EffortPosition & { size?: number }) {
  const step = count > 1 ? sweep / (count - 1) : 0;
  // Keep the dots and rounded arcs separate when a catalog has many levels.
  const scale = Math.min(1, step ? step / 43 : 1);
  const stroke = 2.4 * scale;
  const stops = Array.from({ length: count }, (_, i) => {
    const angle = step ? -sweep / 2 + i * step : 0;
    const size = (i === index ? 2.35 : 1.65) * scale;
    const inset =
      (2 * Math.asin((size + stroke / 2 + 0.65 * scale) / (2 * radius)) * 180) /
      Math.PI;
    return { angle, size, inset };
  });
  return (
    <svg
      data-free
      width={size}
      height={size}
      viewBox="0 0 32 32"
      focusable="false"
      aria-hidden="true"
    >
      {stops.slice(1).map((stop, i) => {
        const previous = stops[i];
        const start = previous.angle + previous.inset,
          end = stop.angle - stop.inset;
        return (
          <path
            d={`M${point(start).join(" ")} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end).join(" ")}`}
            fill="none"
            stroke={i < index ? "var(--role-agent)" : "var(--border-strong)"}
            stroke-width={stroke}
            stroke-linecap="round"
          />
        );
      })}
      {stops.map((stop, i) => {
        const [cx, cy] = point(stop.angle);
        return (
          <circle
            cx={cx}
            cy={cy}
            r={stop.size}
            fill={i <= index ? "var(--role-agent)" : "var(--text-tertiary)"}
          />
        );
      })}
      <path
        d={needle}
        transform={`rotate(${stops[index].angle} ${center.x} ${center.y})`}
        fill="var(--text)"
      />
    </svg>
  );
}

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

export function DispatchSpec({
  id,
  model,
  effort,
  position,
  tier,
  fast,
  width,
}: {
  id?: string;
  model?: string;
  effort?: string;
  position?: EffortPosition;
  tier?: string;
  fast?: boolean;
  width?: number;
}) {
  return (
    <span
      id={id}
      style={width ? { width } : undefined}
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

export function ModelDialog() {
  return (
    <Dialog size="s" title={modelExample.title} description={<p class="text-small leading-5 text-text-secondary">
        {modelExample.description[0]}
        <br />
        {modelExample.description[1]}
      </p>}>
      <div class="flex items-center gap-4">
        <span class="text-small leading-4 font-semibold">{modelExample.setting}</span>
        <SingleChoice
          value="follow"
          options={followModelOptions}
          label={modelExample.choiceLabel}
          dropdown
          class="gap-[18px]"
        />
      </div>
    </Dialog>
  );
}

export function ModelEffortPicker() {
  return (
    <PanelShell width={312} class="p-4">
      <div class="flex items-center gap-[18px]">
        <div class="flex-1">
          <SingleChoice
            value="follow"
            options={followModelOptions}
            label={modelExample.defaultLabel}
            dropdown
            fill
            dropdownIcon="chevron-right"
          />
        </div>
        <IconButton icon="rotate-ccw" compact label={modelExample.resetLabel} />
      </div>
      <div class="mt-5 text-meta leading-4 font-semibold">{modelExample.inherit}</div>
      <div class="mt-[10px]">
        <EffortSlider
          steps={pickerEffortSteps}
          value={0}
          label={modelExample.effortLabel}
          valueText=""
          disabled
        />
      </div>
    </PanelShell>
  );
}

export function ModelMenu() {
  return (
    <PanelShell width={220} class="mt-4 pt-4 pb-[6px] px-4 gap-[9px]">
      <h3 class="text-meta leading-4 text-text-secondary">{modelExample.menuTitle}</h3>
      <div class="flex flex-col">
        {modelOptions.map((model, i) => (
          <div class="flex h-[39px] items-center justify-between text-small">
            <span>{model}</span>
            {i === 0 && <Icon name="check" size={14} />}
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

export function ModelEffort() {
  return (
    <div class="w-[564px] pb-0">
      <ModelDialog />
      <div class="-mt-4 ml-6 flex items-start gap-2">
        <ModelEffortPicker />
        <ModelMenu />
      </div>
    </div>
  );
}
export default () => [
  <Frame name="dispatch-spec-standard"><DispatchSpec {...dispatchExample} /></Frame>,
  ...effortGaugeForms.map(({ name, ...props }) => (
    <Frame name={`effort-gauge-${name}`}><EffortGauge {...props} size={80} /></Frame>
  )),
  <Frame name="effort-slider-stepped" width={280}>
    <EffortSlider steps={effortSteps} {...sliderExample} valueText={effortSteps[0]} />
  </Frame>,
  <Frame
    name="model-effort"
    fixture="timeline-multi-turn"
    capture={{
      selector: ".dialog:has(.task-dispatch-fields)",
      viewport: "1280x800",
      clicks: ["本任务模型", "模型与推理强度", "默认模型: 跟随任务"],
    }}
    note={
      "Explicit hidden target: the portaled picker makes the underlying dialog aria-hidden. " +
      "The portal menu lies outside the dialog capture; review it on the overlay."
    }
  >
    <ModelEffort />
  </Frame>,
];

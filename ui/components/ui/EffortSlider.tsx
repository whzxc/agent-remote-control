import type { CSSProperties } from "react";
import { Slider } from "radix-ui";
import "./TaskControls.css";

export default function EffortSlider({ steps, value, label, valueText, disabled, onChange, onCommit }: {
  steps: string[]; value: number; label: string; valueText: string; disabled?: boolean;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  return <Slider.Root className="effort-slider" min={0} max={steps.length - 1} step={1} value={[value]} disabled={disabled}
    onValueChange={([next]) => onChange(next)} onValueCommit={([next]) => onCommit(next)}>
    <Slider.Track className="effort-slider-track">{steps.map((step, index) => <span key={step} className="effort-slider-mark"
      style={{ "--mark": steps.length > 1 ? index / (steps.length - 1) : 0 } as CSSProperties} />)}</Slider.Track>
    <Slider.Thumb className="effort-slider-thumb" aria-label={label} aria-valuetext={valueText} />
  </Slider.Root>;
}

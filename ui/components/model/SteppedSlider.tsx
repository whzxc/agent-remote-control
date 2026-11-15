import type { CSSProperties } from "react";
import { Slider } from "radix-ui";
import "./SteppedSlider.css";

export default function SteppedSlider({ steps, value, label, valueText, disabled, onChange, onCommit }: {
  steps: string[]; value: number; label: string; valueText: string; disabled?: boolean;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  return <Slider.Root className="stepped-slider" min={0} max={steps.length - 1} step={1} value={[value]} disabled={disabled}
    onValueChange={([next]) => onChange(next)} onValueCommit={([next]) => onCommit(next)}>
    <Slider.Track className="stepped-slider-track">{steps.map((step, index) => <span key={step} className="stepped-slider-mark"
      style={{ "--mark": steps.length > 1 ? index / (steps.length - 1) : 0 } as CSSProperties} />)}</Slider.Track>
    <Slider.Thumb className="stepped-slider-thumb" aria-label={label} aria-valuetext={valueText} />
  </Slider.Root>;
}

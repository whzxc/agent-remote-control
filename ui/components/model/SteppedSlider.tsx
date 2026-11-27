import type { CSSProperties } from "react";
import { SliderPrimitive } from "../kit/slider";
import "./SteppedSlider.css";

export default function SteppedSlider({ steps, value, label, valueText, disabled, onChange, onCommit }: {
  steps: string[]; value: number; label: string; valueText: string; disabled?: boolean;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  return (
    <SliderPrimitive.Root
      min={0}
      max={steps.length - 1}
      step={1}
      value={value}
      disabled={disabled}
      thumbAlignment="edge"
      onValueChange={next => onChange(next)}
      onValueCommitted={next => onCommit(next)}
    >
      <SliderPrimitive.Control className="stepped-slider">
        <SliderPrimitive.Track className="stepped-slider-track">
          {steps.map((step, index) => (
            <span
              key={step}
              className="stepped-slider-mark"
              style={{ "--mark": steps.length > 1 ? index / (steps.length - 1) : 0 } as CSSProperties}
            />
          ))}
          <SliderPrimitive.Thumb
            className="stepped-slider-thumb"
            style={{ visibility: "visible" }}
            getAriaLabel={() => label}
            aria-valuetext={valueText}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

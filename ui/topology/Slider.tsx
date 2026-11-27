import "./Slider.css";
import { SliderPrimitive } from "../components/kit/slider";

export function Slider({ label, value, min, max, step, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  return (
    <SliderPrimitive.Root
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={next => onChange(next)}
      onValueCommitted={next => onCommit(next)}
    >
      <SliderPrimitive.Control className="slider">
        <SliderPrimitive.Track className="slider-track">
          <SliderPrimitive.Indicator className="slider-fill" />
          <SliderPrimitive.Thumb
            className="slider-thumb"
            getAriaLabel={() => label}
            onBlur={() => onCommit(value)}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

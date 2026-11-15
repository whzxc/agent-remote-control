import './Slider.css';





import { Slider as RS } from "radix-ui";




export function Slider({ label, value, min, max, step, onChange, onCommit }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (value: number) => void; onCommit: (value: number) => void;
}) {
  return <RS.Root className="slider" value={[value]} min={min} max={max} step={step}
    onValueChange={values => onChange(values[0])} onValueCommit={values => onCommit(values[0])} onBlur={() => onCommit(value)}>
    <RS.Track className="slider-track"><RS.Range className="slider-fill" /></RS.Track>
    <RS.Thumb className="slider-thumb" aria-label={label} />
  </RS.Root>;
}

import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { RotateCcw } from "lucide-react";
import { t } from "../i18n";
import { IconButton, SingleChoice } from "./ui";
import EffortSlider from "./ui/EffortSlider";
import ChoiceTrigger from "./ui/ChoiceTrigger";
import "./ModelEffortPicker.css";

// Radix radio values must be nonempty; it maps to "" (inheritance) on change.
const INHERIT = "inherit";

export function effortLabel(value: string) {
  const key = `dispatchSpec.effort.${value}`;
  return t(key) === key ? value : t(key);
}

/** One trigger for a model and effort pair: effort on a stepped slider, model in a nested menu. */
export default function ModelEffortPicker({ label, models, efforts, model, effort, inheritLabel, withEffort, disabled, onChange }: {
  label: string;
  models: { value: string; label: string }[];
  /** Efforts the selected model supports, in ascending order. */
  efforts: string[];
  model: string;
  effort: string;
  inheritLabel: string;
  withEffort: boolean;
  disabled?: boolean;
  onChange: (next: { model: string; effort: string }) => void;
}) {
  const steps = [INHERIT, ...efforts.filter(value => value !== INHERIT)];
  if (effort && !steps.includes(effort)) steps.push(effort);
  const committed = Math.max(0, steps.indexOf(effort || INHERIT));
  // Follow the thumb while dragging; save only when the drag ends.
  const [preview, setPreview] = useState(committed);
  useEffect(() => setPreview(committed), [committed]);
  const stepLabel = (index: number) => steps[index] === INHERIT ? inheritLabel : effortLabel(steps[index]);
  const modelName = model ? models.find(row => row.value === model)?.label ?? model : inheritLabel;
  const summary = [model ? modelName : "", withEffort && effort ? effortLabel(effort) : ""].filter(Boolean).join(" · ") || inheritLabel;
  const commit = (index: number) => {
    const value = steps[index] === INHERIT ? "" : steps[index];
    if (value !== effort) onChange({ model, effort: value });
  };
  return <Popover.Root>
    <Popover.Trigger asChild>
      <ChoiceTrigger aria-label={label} disabled={disabled}>{summary}</ChoiceTrigger>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="popover spec-picker" aria-label={label} side="bottom" align="start" sideOffset={8} collisionPadding={12}>
        <div className="spec-picker-model-row">
          <SingleChoice dropdown label={`${t("dispatchDefaults.model")}: ${modelName}`} value={model || INHERIT} disabled={disabled}
            options={[{ value: INHERIT, label: inheritLabel }, ...models]} menuLabel={t("dispatchDefaults.chooseModel")} side="right"
            onChange={value => onChange({ model: value === INHERIT ? "" : value, effort })} />
          <IconButton compact variant="ghost" icon={RotateCcw} label={t("dispatchDefaults.reset")} disabled={disabled || (!model && !effort)}
            onClick={() => onChange({ model: "", effort: "" })} />
        </div>
        {withEffort && <div className="spec-picker-effort"><strong aria-live="polite">{stepLabel(preview)}</strong>
          <EffortSlider steps={steps} value={preview} disabled={disabled} label={t("dispatchDefaults.effort")} valueText={stepLabel(preview)} onChange={setPreview} onCommit={commit} />
        </div>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

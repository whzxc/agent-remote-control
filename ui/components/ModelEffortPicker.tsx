import { useEffect, useState, type CSSProperties } from "react";
import { DropdownMenu as M, Popover, Slider as RS } from "radix-ui";
import { Check, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { t } from "../i18n";
import { Icon, IconButton } from "./ui";
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
      <button type="button" className="spec-picker-trigger" aria-label={label} disabled={disabled}>
        <span>{summary}</span><Icon icon={ChevronDown} />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="popover spec-picker" aria-label={label} side="bottom" align="end" sideOffset={8} collisionPadding={12}>
        <header>
          <span />
          <strong aria-live="polite">{withEffort ? stepLabel(preview) : modelName}</strong>
          <IconButton icon={RotateCcw} label={t("dispatchDefaults.reset")} disabled={disabled || (!model && !effort)}
            onClick={() => onChange({ model: "", effort: "" })} />
        </header>
        <M.Root>
          <M.Trigger asChild>
            <button type="button" className="spec-picker-model" disabled={disabled} aria-label={`${t("dispatchDefaults.model")}: ${modelName}`}>
              {modelName}<Icon icon={ChevronRight} />
            </button>
          </M.Trigger>
          <M.Portal>
            <M.Content className="menu spec-picker-models" aria-label={t("dispatchDefaults.model")} side="bottom" align="center" sideOffset={6} collisionPadding={12}>
              <M.Label className="spec-picker-models-title">{t("dispatchDefaults.chooseModel")}</M.Label>
              <M.RadioGroup value={model || INHERIT} onValueChange={value => onChange({ model: value === INHERIT ? "" : value, effort })}>
                {[{ value: INHERIT, label: inheritLabel }, ...models].map(row => <M.RadioItem key={row.value} value={row.value} className="menu-item">
                  {row.label}<M.ItemIndicator><Icon icon={Check} /></M.ItemIndicator>
                </M.RadioItem>)}
              </M.RadioGroup>
            </M.Content>
          </M.Portal>
        </M.Root>
        {withEffort && <RS.Root className="spec-picker-slider" min={0} max={steps.length - 1} step={1} value={[preview]} disabled={disabled}
          onValueChange={([value]) => setPreview(value)} onValueCommit={([value]) => commit(value)}>
          <RS.Track className="spec-picker-track">
            <RS.Range className="spec-picker-range" />
            {steps.map((step, index) => <span key={step} className="spec-picker-mark" data-filled={index <= preview || undefined}
              style={{ "--mark": `${steps.length > 1 ? index / (steps.length - 1) : 0}` } as CSSProperties} />)}
          </RS.Track>
          <RS.Thumb className="spec-picker-thumb" aria-label={t("dispatchDefaults.effort")} aria-valuetext={stepLabel(preview)} />
        </RS.Root>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

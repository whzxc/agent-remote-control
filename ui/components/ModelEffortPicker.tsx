import { TransientLayer } from "./ui/TransientLayer";
import { useEffect, useId, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { t } from "../i18n";
import { PopoverPrimitive } from "./kit/popover";
import { IconButton, SingleChoice } from "./ui";
import { effortGaugePosition, effortLabel } from "./composites/dispatchSpecLabel";
import DispatchSpec from "./ui/DispatchSpec";
import EffortGauge from "./ui/EffortGauge";
import SteppedSlider from "./model/SteppedSlider";
import ChoiceTrigger from "./ui/ChoiceTrigger";
import "./ModelEffortPicker.css";

// Choice radio values must be nonempty; it maps to "" (inheritance) on change.
const INHERIT = "inherit";

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
  const specId = useId();
  const steps = [INHERIT, ...efforts.filter(value => value !== INHERIT)];
  if (effort && !steps.includes(effort)) steps.push(effort);
  const committed = Math.max(0, steps.indexOf(effort || INHERIT));
  // Follow the thumb while dragging; save only when the drag ends.
  const [preview, setPreview] = useState(committed);
  useEffect(() => setPreview(committed), [committed]);
  const stepLabel = (index: number) => steps[index] === INHERIT ? inheritLabel : effortLabel(steps[index], t);
  const modelName = model ? models.find(row => row.value === model)?.label ?? model : inheritLabel;
  const selectedEffort = withEffort && effort ? effortLabel(effort, t) : undefined;
  const previewEffort = steps[preview] !== INHERIT ? steps[preview] : undefined;
  const commit = (index: number) => {
    const value = steps[index] === INHERIT ? "" : steps[index];
    if (value !== effort) onChange({ model, effort: value });
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popupNode, setPopupNode] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !popupNode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!(event.target instanceof Node) || !popupNode.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, popupNode]);
  return <PopoverPrimitive.Root
    open={open}
    onOpenChange={(next, details) => {
      if (!next && details.reason === "escape-key") {
        details.event.stopPropagation();
        details.event.stopImmediatePropagation?.();
      }
      setOpen(next);
    }}
  >
    <PopoverPrimitive.Trigger
      render={
        <ChoiceTrigger ref={triggerRef} aria-label={label} aria-describedby={specId} disabled={disabled} data-dispatch-spec="">
          <DispatchSpec id={specId} model={model ? modelName : selectedEffort ? undefined : inheritLabel}
            effort={selectedEffort} position={effortGaugePosition(efforts, effort)} />
        </ChoiceTrigger>
      }
    />
    <PopoverPrimitive.Portal>
      <TransientLayer onDismiss={() => setOpen(false)}>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="z-60">
          <PopoverPrimitive.Popup
            ref={setPopupNode}
            role="dialog"
            finalFocus={triggerRef}
            className="popover spec-picker"
            aria-label={label}
            style={{ maxHeight: "min(70dvh, var(--available-height))" }}
          >
            <div className="spec-picker-model-row">
              <SingleChoice dropdown label={`${t("dispatchDefaults.model")}: ${modelName}`} value={model || INHERIT} disabled={disabled}
                options={[{ value: INHERIT, label: inheritLabel }, ...models]} menuLabel={t("dispatchDefaults.chooseModel")} side="right"
                onChange={value => onChange({ model: value === INHERIT ? "" : value, effort })} />
              <IconButton compact variant="ghost" icon={RotateCcw} label={t("dispatchDefaults.reset")} disabled={disabled || (!model && !effort)}
                onClick={() => onChange({ model: "", effort: "" })} />
            </div>
            {withEffort && <div className="spec-picker-effort"><strong aria-live="polite">
              {previewEffort && <EffortGauge {...effortGaugePosition(efforts, previewEffort)} />}{stepLabel(preview)}
            </strong>
              <SteppedSlider steps={steps} value={preview} disabled={disabled} label={t("dispatchDefaults.effort")} valueText={stepLabel(preview)} onChange={setPreview} onCommit={commit} />
            </div>}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </TransientLayer>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

import { DispatchSpec } from '../components/dispatch-spec';
import { Frame, Icon } from "adg";
import { Dialog } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { IconButton } from "../components/icon-button";
import { SteppedSlider } from "../components/stepped-slider";
import { dispatchExample, effortGaugeForms, modelExample, followModelOptions, pickerEffortSteps, modelOptions } from '../fixtures/model-configuration';

export function ModelDialog() {
  return (
    <Dialog title={modelExample.title} description={<span class="whitespace-nowrap">{modelExample.description.join("")}</span>}>
      <div class="flex items-center gap-4 min-h-9">
        <span class="text-small leading-4 font-semibold">{modelExample.setting}</span>
        <div><span class="inline-flex items-center gap-2 rounded-control bg-surface-sunken pl-[7px] pr-3 min-h-9">
          <DispatchSpec model={modelExample.inherit} /><Icon name="chevron-down" size={14} />
        </span></div>
      </div>
    </Dialog>
  );
}

export function ModelEffortPicker() {
  return (
    <section class="flex w-[312px] flex-col rounded-panel bg-surface-raised text-text shadow-lg p-4">
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
        <SteppedSlider
          steps={pickerEffortSteps}
          value={0}
          label={modelExample.effortLabel}
          valueText=""
          disabled
        />
      </div>
    </section>
  );
}

export function ModelMenu() {
  return (
    <section class="flex w-[220px] flex-col rounded-panel bg-surface-raised text-text shadow-lg mt-4 pt-4 pb-[6px] px-4 gap-[9px]">
      <h3 class="text-meta leading-4 text-text-secondary">{modelExample.menuTitle}</h3>
      <div class="flex flex-col">
        {modelOptions.map((model, i) => (
          <div class="flex h-[39px] items-center justify-between text-small">
            <span>{model}</span>
            {i === 0 && <Icon name="check" size={14} />}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ModelEffort() {
  return (
    <ModelDialog />
  );
}
export default () => [
  <Frame name="picker" fixture="model-picker"
    capture={{ selector: ".spec-picker", viewport: "1280x800" }}><ModelEffortPicker /></Frame>,
  <Frame name="menu" fixture="model-menu"
    capture={{ selector: "[role=menu]", viewport: "1280x800" }}><ModelMenu /></Frame>,
  <Frame
    name="model-effort"
    fixture="model-dialog"
    capture={{
      selector: ".dialog:has(.task-dispatch-fields)",
      viewport: "1280x800",
    }}
    note={
      "Explicit hidden target: the portaled picker makes the underlying dialog aria-hidden. " +
      "The portal menu lies outside the dialog capture; review it on the overlay."
    }
  >
    <ModelEffort />
  </Frame>,
];

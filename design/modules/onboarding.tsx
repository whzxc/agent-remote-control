import { Frame } from "adg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { SingleChoice } from "../components/single-choice";
import { Field, Input } from "../components/field";
import { onboardingFrames, onboardingCopy } from "../fixtures/onboarding";
import { connectionCopy } from "../fixtures/connection-onboarding";

export type OnboardingStep = {
  name: string;
  fixture: string;
  title?: string;
  labels?: string[];
  active?: number;
  subtitle?: string;
  done?: boolean;
  back?: string;
  action?: string;
  busy?: boolean;
  body: string;
};
export function OnboardingChoiceField({
  label,
  options,
  value,
  class: extra = "",
}: {
  label: string;
  options: string[];
  value: string;
  class?: string;
}) {
  return (
    <div class={`flex flex-col gap-3 ${extra}`}>
      <h3 class="text-small leading-4 font-semibold">{label}</h3>
      <SingleChoice
        label={label}
        value={value}
        options={options.map((label) => ({ value: label, label }))}
        fill
      />
    </div>
  );
}
export function OnboardingField({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: string;
}) {
  return (
    <Field
      label={
        <span class="flex items-center gap-3">
          {label}
          {action && <span class="font-semibold">{action}</span>}
        </span>
      }
    >
      <Input value={value} />
    </Field>
  );
}
export function OnboardingSteps({ step }: { step: OnboardingStep }) {
  return (
    <ol class="flex gap-3">
      {step.labels!.map((label, i) => (
        <li class="flex min-w-0 flex-1 flex-col gap-[6px]">
          <span
            class={`h-[3px] rounded-[2px] ${step.done ? "bg-success" : i <= step.active! ? "bg-accent" : "bg-surface-sunken"}`}
          />
          <span
            class={`text-meta leading-4 ${i === step.active ? "font-semibold text-text" : "text-text-secondary"}`}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
export function OnboardingFooter({ step }: { step: OnboardingStep }) {
  const widths: Record<string, string> = {
    "method": "min-w-[216px]",
    "relay": "min-w-[216px]",
    "ready": "min-w-[168px]",
    "local": "min-w-[120px]",
    "join": "min-w-[120px]",
    "own": "min-w-[120px]",
    "secure": "min-w-[120px]",
    "source-local": "min-w-[176px]",
    "address": "min-w-[200px]",
    "approval": "min-w-[110px]",
    "success": "min-w-[116px]"
  };
  const actionWidth = widths[step.body] ?? (step.action === onboardingCopy.continue ? "min-w-[76px]" : "");
  return (
    <footer
      class={`flex items-center gap-4 ${step.body === "approval" ? "justify-end" : "justify-between"}`}
    >
      {step.back ? (
        <Button
          variant={step.body === "approval" ? "secondary" : "ghost"}
          class={step.body === "approval" ? "min-w-[76px]" : "min-w-16"}
        >
          {step.back}
        </Button>
      ) : (
        <span />
      )}
      {step.action && (
        <Button
          variant="primary"
          busy={step.busy}
          disabled={step.body === "products"}
          icon={step.body === "method" ? "external-link" : undefined}
          class={`${step.busy ? "justify-start! " : ""}${step.body === "products" ? "opacity-45 " : ""}${actionWidth}`}
        >
          {step.action}
        </Button>
      )}
    </footer>
  );
}
export function OnboardingShell({ step, children }: { step: OnboardingStep; children?: unknown }) {
  const nested = step.name.startsWith("stacked-");
  const subtitle = nested
    ? onboardingCopy.returnPrefix +
      (step.body === "secure" ? onboardingCopy.secureProduct : onboardingCopy.sourceProduct) + onboardingCopy.returnSuffix
    : step.subtitle;
  return (
    <Panel width={680} headerless>
      <div class="flex flex-col">
        <header class="flex h-(--control-height) items-center justify-between">
          <h2 class="text-title leading-6 font-[650]">
            {step.title || onboardingCopy.title}
          </h2>
          <IconButton icon="x" label={onboardingCopy.close} />
        </header>
        {subtitle && (
          <p
            class={`mt-[6px] text-meta leading-4 ${nested ? "text-text-tertiary" : "text-text-secondary"}`}
          >
            {subtitle}
          </p>
        )}
        <div class="mt-[15px]"><OnboardingSteps step={step} /></div>
        <div class="mt-[27px]">
          {children}
        </div>
        <div class="mt-6"><OnboardingFooter step={step} /></div>
      </div>
    </Panel>
  );
}
export default () => [
  <Frame name="onboarding-choice-field" width={632}>
    <div class="w-full bg-surface-raised">
      <OnboardingChoiceField label={connectionCopy.https} options={connectionCopy.providers} value={connectionCopy.provider} />
    </div>
  </Frame>,
  <Frame name="onboarding-field" width={308}>
    <div class="w-full bg-surface-raised"><OnboardingField label={connectionCopy.domainLabel} value={connectionCopy.domain} /></div>
  </Frame>,
  <Frame name="onboarding-steps" width={632}>
    <div class="w-full bg-surface-raised"><OnboardingSteps step={onboardingFrames.find(step => step.body === "approval")!} /></div>
  </Frame>,
  <Frame name="onboarding-footer" width={632}>
    <div class="w-full bg-surface-raised"><OnboardingFooter step={onboardingFrames.find(step => step.body === "approval")!} /></div>
  </Frame>,
];

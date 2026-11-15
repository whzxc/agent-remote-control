import type { OnboardingStep } from '../components/onboarding-fields';
import { Frame } from "adg";
import { Dialog } from "../components/panel";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { SingleChoice } from "../components/single-choice";
import { Field, Input } from "../components/field";
import { onboardingFrames, onboardingCopy } from "../fixtures/onboarding";
import { connectionCopy } from "../fixtures/connection-onboarding";
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
    <Dialog viewportHeight={step.body === "own" ? 1000 : 800} title={step.title || onboardingCopy.title}
      headerDetail={<>
        {subtitle && <p class="text-meta leading-4 text-text-secondary">{subtitle}</p>}
        <OnboardingSteps step={step} />
      </>}
      footer={<OnboardingFooter step={step} />}>
      {children}
    </Dialog>
  );
}
export default () => [
  <Frame name="onboarding-steps" width={632}>
    <div class="w-full bg-surface-raised"><OnboardingSteps step={onboardingFrames.find(step => step.body === "approval")!} /></div>
  </Frame>,
  <Frame name="onboarding-footer" width={632}>
    <div class="w-full bg-surface-raised"><OnboardingFooter step={onboardingFrames.find(step => step.body === "approval")!} /></div>
  </Frame>,
];

import { Frame } from "adg";
import type { ReactNode } from "react";
import { LocaleProvider } from "@/i18n/react";
import { OnboardingFooter, OnboardingSteps } from "../components/setup-flow";
import { onboardingFrames } from "../fixtures/onboarding";

export function SetupWelcome({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface-raised shadow-lg">
      {children}
    </section>
  );
}

export function SetupApproval({ children }: { children: ReactNode }) {
  return (
    <form className="rounded-kit-card border border-border">{children}</form>
  );
}

export function SetupImpact({ children }: { children: ReactNode }) {
  return <p className="text-meta text-text-secondary">{children}</p>;
}

const step = onboardingFrames.find((entry) => entry.body === "approval")!;

export default () => [
  <Frame key="onboarding-steps" name="onboarding-steps" width={632}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <OnboardingSteps step={step} />
      </div>
    </LocaleProvider>
  </Frame>,
  <Frame key="onboarding-footer" name="onboarding-footer" width={632}>
    <LocaleProvider locale="zh-CN">
      <div className="w-full bg-surface-raised">
        <OnboardingFooter step={step} />
      </div>
    </LocaleProvider>
  </Frame>,
];

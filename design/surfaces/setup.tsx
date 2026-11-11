import { Frame } from "adg";
import { OnboardingShell } from "../modules/onboarding";
import { Welcome } from "../modules/welcome";
import { SourceOnboarding } from "../modules/source-onboarding";
import { ConnectionOnboarding } from "../modules/connection-onboarding";
import { onboardingFrames, onboardingCopy } from "../fixtures/onboarding";
import { welcomeCopy } from "../fixtures/welcome";

export default () =>
  onboardingFrames.map((step) => (
    <Frame
      name={step.name}
      fixture={step.fixture}
      capture={
        step.name.startsWith("stacked-")
          ? {
              selector: ".setup-dialog:has(.setup-return)",
              viewport: step.body === "own" ? "1280x1000" : "1280x800",
            }
          : {
              region:
                step.body === "welcome"
                  ? welcomeCopy.title
                  : step.title || onboardingCopy.title,
              viewport: "1280x800",
            }
      }
      note={
        step.name.startsWith("stacked-")
          ? "Nested child shell. Width drift: asset 680px; implementation 680px × .92 rounds to 626px. Zero " +
            "extracted texts in nested dialogs are an ARC accessibility defect."
          : undefined
      }
    >
      {step.body === "welcome" ? <Welcome /> : (
        <OnboardingShell step={step}>
          {step.name.startsWith("source-")
            ? <SourceOnboarding step={step} /> : <ConnectionOnboarding step={step} />}
        </OnboardingShell>
      )}
    </Frame>
  ));

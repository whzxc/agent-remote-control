import { Frame } from "adg";
import { OnboardingShell } from "../modules/onboarding";
import { Welcome } from "../modules/welcome";
import { SourceOnboarding } from "../modules/source-onboarding";
import { ConnectionOnboarding } from "../modules/connection-onboarding";
import { onboardingFrames } from "../fixtures/onboarding";

export default () =>
  onboardingFrames.map((step) => (
    <Frame
      name={step.name}
      fixture={step.fixture}
      capture={{
        selector: step.body === "welcome" ? ".welcome-page" : step.name.startsWith("stacked-")
          ? ".layer-dialog:has(> .layer-content > .setup-return)" : ".layer-dialog:has(> .layer-content > .setup-steps)",
        viewport: step.body === "own" ? "1280x1000" : "1280x800",
      }}
      note={step.name.startsWith("stacked-") ? "M child-dialog region. Its parent stays mounted and stationary under the scrim; p3-stacked acceptance covers the pair." : undefined}
    >
      {step.body === "welcome" ? <Welcome /> : (
        <OnboardingShell step={step}>
          {step.name.startsWith("source-")
            ? <SourceOnboarding step={step} /> : <ConnectionOnboarding step={step} />}
        </OnboardingShell>
      )}
    </Frame>
  ));

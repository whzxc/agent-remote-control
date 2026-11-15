import { Frame } from 'adg';
import { OnboardingSteps, OnboardingFooter } from '../components/setup-flow';
import { onboardingFrames } from '../fixtures/onboarding';
const step = onboardingFrames.find(step => step.body === 'approval')!;
export default () => [
  <Frame name="onboarding-steps" width={632}><div class="w-full bg-surface-raised"><OnboardingSteps step={step}/></div></Frame>,
  <Frame name="onboarding-footer" width={632}><div class="w-full bg-surface-raised"><OnboardingFooter step={step}/></div></Frame>,
];

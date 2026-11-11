import { Frame } from "adg";
import { Button } from "../components/button";
import { SingleChoice } from "../components/single-choice";
import { CopyField } from "../components/copy-field";
import { Tile } from "../components/tile";
import { OnboardingField, OnboardingChoiceField, type OnboardingStep } from "./onboarding";
import { connectionCopy } from "../fixtures/connection-onboarding";
import { onboardingFrames, methods, maskedAddress } from "../fixtures/onboarding";

export function ConnectionOperations() {
  return (
    <div class="flex flex-col gap-[7px]">
      <OnboardingChoiceField
        label={connectionCopy.operationLabel}
        options={connectionCopy.operationOptions}
        value={connectionCopy.operationValue}
      />
      <div class="flex items-center gap-2">
        <p class="text-meta text-text-secondary">{connectionCopy.operationSummary}</p>
        <Button variant="ghost">{connectionCopy.viewOperations}</Button>
      </div>
    </div>
  );
}
export function ConnectionOnboarding({ step }: { step: OnboardingStep }) {
  const nested = step.name.startsWith("stacked-");
  switch (step.body) {
    case "local":
      return (
        <p class="text-body leading-6">{connectionCopy.localInstall}</p>
      );
    case "method":
      return (
        <div class="flex flex-col gap-[38px]">
          <SingleChoice
            label={connectionCopy.method}
            value="relay"
            options={methods}
            form="setup-row"
          />
          {!nested && (
            <div class="grid grid-cols-[224px_186px_1fr] gap-4">
              {connectionCopy.extraMethods.map(
                (label, i) => (
                  <SingleChoice
                    label={label}
                    value=""
                    form="setup-row"
                    catalog
                    options={[{ value: label, label }]}
                  />
                ),
              )}
            </div>
          )}
        </div>
      );
    case "relay":
    case "login":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-6">
            {connectionCopy.relaySteps.map((label, i) => (
              <div class="flex items-center gap-4">
                <Tile
                  icon={
                    i === 0
                      ? step.body === "login"
                        ? "loader-circle"
                        : "check"
                      : i === 1 && step.body === "relay"
                        ? "loader-circle"
                        : "circle"
                  }
                  tone={
                    i === 0 && step.body === "relay"
                      ? "success"
                      : i === 0 || (i === 1 && step.body === "relay")
                        ? "accent"
                        : "neutral"
                  }
                />
                <div class="flex flex-col gap-[10px]">
                  <h3 class="text-body leading-[14px] font-[650]">{label}</h3>
                  {((step.body === "login" && i < 2) ||
                    (step.body === "relay" && i === 1)) && (
                    <p class="text-meta leading-[14px] text-text-secondary">
                      {i === 0
                        ? "请在浏览器中完成授权"
                        : step.body === "login"
                          ? "大约 20 秒"
                          : "进行中 · 大约 20 秒"}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {step.body === "login" && (
            <Button variant="ghost">{connectionCopy.copyLogin}</Button>
          )}
        </div>
      );
    case "join":
      return (
        <div class="flex flex-col gap-6">
          <OnboardingField label={connectionCopy.sharedLink} value="" />
          <div class="flex flex-col gap-[6px]">
            <OnboardingField label={connectionCopy.machineLabel} value={connectionCopy.machineName} />
            <p class="text-meta leading-4 text-text-secondary">{connectionCopy.visibility}</p>
          </div>
        </div>
      );
    case "own":
      return (
        <div class="flex flex-col">
          <OnboardingChoiceField
            label={connectionCopy.https}
            options={connectionCopy.providers}
            value={connectionCopy.provider}
            class="mb-[14px]"
          />
          <OnboardingChoiceField
            label={connectionCopy.domainMode}
            options={connectionCopy.domainModes}
            value={connectionCopy.fixedDomain}
            class="mb-[22px]"
          />
          <div class="grid grid-cols-2 gap-4 mb-4">
            <OnboardingField label={connectionCopy.domainLabel} value={connectionCopy.domain} />
            <OnboardingField label={connectionCopy.connectionLabel} value={connectionCopy.connectionName} />
          </div>
          <OnboardingField
            label={connectionCopy.tokenLabel}
            value={connectionCopy.tokenPlaceholder}
            action={connectionCopy.credentialsAction}
          />
          <OnboardingChoiceField
            class="mt-4"
            label={connectionCopy.identity}
            options={connectionCopy.authOptions}
            value={connectionCopy.auth}
          />
          <div class="mt-[26px]">
            <ConnectionOperations />
          </div>
        </div>
      );
    case "secure":
      return (
        <div class="flex flex-col gap-6">
          {connectionCopy.credentials.map((field) => (
            <OnboardingField {...field} />
          ))}
          <div>
            <ConnectionOperations />
          </div>
        </div>
      );
    case "ready":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex items-center gap-4">
            <Tile icon="check" tone="success" />
            <h3 class="text-title leading-6 font-[650]">{connectionCopy.ready}</h3>
          </div>
          <div class="flex flex-col rounded-card bg-surface-subtle p-5">
            <h3 class="text-body leading-4 font-[650]">{connectionCopy.relay}</h3>
            <p class="mt-[10px] flex items-center gap-2 text-meta leading-4 text-text-secondary">
              <span class="size-[6px] rounded-full bg-success" />{connectionCopy.online}</p>
            <p class="mt-[18px] text-small leading-4 text-text-secondary">{connectionCopy.relayLink}</p>
            <div class="mt-2">
              <CopyField value={maskedAddress} masked />
            </div>
          </div>
        </div>
      );
    default: return null;
  }
}
export default () => [
  ...onboardingFrames.filter(step => !step.name.startsWith("source-") && step.body !== "welcome"
    && step.name !== "stacked-ready").map(step => (
    <Frame name={`connection-onboarding-${step.name === "stacked-method" ? "nested-method" : step.body}`} width={632}>
      <div class="w-full bg-surface-raised"><ConnectionOnboarding step={step} /></div>
    </Frame>
  )),
  <Frame name="connection-operations" width={632}>
    <div class="w-full bg-surface-raised"><ConnectionOperations /></div>
  </Frame>,
];

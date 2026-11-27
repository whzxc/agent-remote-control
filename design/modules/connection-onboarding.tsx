import { Frame } from "adg";
import {
  ConnectionJoinStepView,
  ConnectionLocalStepView,
  ConnectionMethodStepView,
  ConnectionReadyStepView,
} from "@/components/connectivity/ConnectionOnboardingView";
import { IngressFormView } from "@/components/connectivity/IngressFormView";
import {
  RelayProgressView,
  type RelayProgressStep,
} from "@/components/connectivity/RelayProgressView";
import { ToolPolicyView } from "@/components/connectivity/ToolPolicyView";
import { Button, Field, Input, PrivacyProvider } from "@/components/kit";
import { LocaleProvider } from "@/i18n/react";
import type { OnboardingStep } from "../components/onboarding-fields";
import { connectionCopy } from "../fixtures/connection-onboarding";
import {
  maskedAddress,
  methods,
  onboardingFrames,
} from "../fixtures/onboarding";

function StaticField({
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
      label={label}
      helpPlacement="label"
      help={
        action ? (
          <Button variant="ghost" size="xs">
            {action}
          </Button>
        ) : undefined
      }
    >
      <Input value={value} readOnly />
    </Field>
  );
}

export function ConnectionOperations() {
  return (
    <LocaleProvider locale="zh-CN">
      <ToolPolicyView
        label={connectionCopy.operationLabel}
        value={connectionCopy.operationValue}
        options={connectionCopy.operationOptions.map((label) => ({
          value: label,
          label,
        }))}
        summary={connectionCopy.operationSummary}
        viewAllLabel={connectionCopy.viewOperations}
      />
    </LocaleProvider>
  );
}

export function ConnectionOnboarding({ step }: { step: OnboardingStep }) {
  const nested = step.name.startsWith("stacked-");

  const relaySteps: RelayProgressStep[] = connectionCopy.relaySteps.map(
    (label, index) => ({
      id: label,
      label,
      state:
        index === 0
          ? step.body === "login"
            ? "running"
            : "complete"
          : index === 1 && step.body === "relay"
            ? "running"
            : "waiting",
      detail:
        (step.body === "login" && index < 2) ||
        (step.body === "relay" && index === 1)
          ? index === 0
            ? connectionCopy.authorize
            : step.body === "login"
              ? connectionCopy.estimate
              : connectionCopy.runningEstimate
          : undefined,
    }),
  );

  const methodOptions = nested
    ? methods
    : [
        ...methods,
        ...connectionCopy.extraMethods.map((label) => ({
          value: label,
          label,
        })),
      ];

  const [readyStatus, readyCount] = connectionCopy.online.split(" · ");

  return (
    <LocaleProvider locale="zh-CN">
      <PrivacyProvider hidden>
        {step.body === "local" ? (
          <ConnectionLocalStepView description={connectionCopy.localInstall} />
        ) : step.body === "method" ? (
          <ConnectionMethodStepView
            label={connectionCopy.method}
            value="relay"
            options={methodOptions}
            secondaryFrom={nested ? undefined : 3}
          />
        ) : step.body === "relay" || step.body === "login" ? (
          <RelayProgressView
            steps={relaySteps}
            copyLoginLabel={
              step.body === "login" ? connectionCopy.copyLogin : undefined
            }
          />
        ) : step.body === "join" ? (
          <ConnectionJoinStepView
            linkLabel={connectionCopy.sharedLink}
            linkValue=""
            deviceLabel={connectionCopy.machineLabel}
            deviceValue={connectionCopy.machineName}
            visibilityHint={connectionCopy.visibility}
          />
        ) : step.body === "own" ? (
          <IngressFormView
            setupLayout
            https
            httpsProvider={{
              label: connectionCopy.https,
              value: connectionCopy.provider,
              options: connectionCopy.providers.map((label) => ({
                value: label,
                label,
              })),
            }}
            domainMode={{
              label: connectionCopy.domainMode,
              value: connectionCopy.fixedDomain,
              options: connectionCopy.domainModes.map((label) => ({
                value: label,
                label,
              })),
            }}
            domainField={
              <StaticField
                label={connectionCopy.domainLabel}
                value={connectionCopy.domain}
              />
            }
            setupNameField={
              <StaticField
                label={connectionCopy.connectionLabel}
                value={connectionCopy.connectionName}
              />
            }
            credentialField={
              <StaticField
                label={connectionCopy.tokenLabel}
                value={connectionCopy.tokenPlaceholder}
                action={connectionCopy.credentialsAction}
              />
            }
            authentication={{
              label: connectionCopy.identity,
              value: connectionCopy.auth,
              options: connectionCopy.authOptions.map((label) => ({
                value: label,
                label,
              })),
            }}
            toolPolicyField={<ConnectionOperations />}
          />
        ) : step.body === "secure" ? (
          <IngressFormView
            setupLayout
            https={false}
            tunnelFields={
              <>
                {connectionCopy.credentials.slice(0, 2).map((field) => (
                  <StaticField key={field.label} {...field} />
                ))}
              </>
            }
            setupNameField={
              <StaticField {...connectionCopy.credentials[2]} />
            }
            toolPolicyField={<ConnectionOperations />}
          />
        ) : step.body === "ready" ? (
          <ConnectionReadyStepView
            heading={connectionCopy.ready}
            connection={{
              name: connectionCopy.relay,
              online: true,
              statusLabel: readyStatus ?? connectionCopy.online,
              sourceCountLabel: readyCount ?? "",
              kindLabel: connectionCopy.relayLink,
              address: maskedAddress,
              copyAddressLabel: connectionCopy.relayLink,
            }}
          />
        ) : null}
      </PrivacyProvider>
    </LocaleProvider>
  );
}

export default () => [
  ...onboardingFrames
    .filter(
      (step) =>
        !step.name.startsWith("source-") &&
        step.body !== "welcome" &&
        step.name !== "stacked-ready",
    )
    .map((step) => (
      <Frame
        key={step.name}
        name={`connection-onboarding-${step.name === "stacked-method" ? "nested-method" : step.body}`}
        width={632}
      >
        <div className="w-full bg-surface-raised">
          <ConnectionOnboarding step={step} />
        </div>
      </Frame>
    )),
  <Frame key="connection-operations" name="connection-operations" width={632}>
    <div className="w-full bg-surface-raised">
      <ConnectionOperations />
    </div>
  </Frame>,
];

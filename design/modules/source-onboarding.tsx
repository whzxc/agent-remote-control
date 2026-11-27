import { Frame, Icon } from "adg";
import { Cloud, Link, Plug, Plus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { OAuthApprovalView } from "@/components/connectivity/OAuthApprovalView";
import {
  SetupActionCard,
  SourceAddressStepView,
  SourceConnectionStepView,
  SourceProductPickerView,
  SourceSuccessStepView,
} from "@/components/connectivity/SourceOnboardingView";
import { PrivacyProvider } from "@/components/kit";
import { LocaleProvider } from "@/i18n/react";
import Gemini from "../art/gemini.svg";
import GithubCopilot from "../art/github-copilot.svg";
import grokBot from "../art/grok-bot.png";
import Grok from "../art/grok.svg";
import Copilot from "../art/microsoft-copilot.svg";
import Qwen from "../art/qwen-code.svg";
import { BrandMark, type Brand } from "../components/brand-mark";
import type { OnboardingStep } from "../components/onboarding-fields";
import {
  maskedAddress,
  methods,
  onboardingFrames,
} from "../fixtures/onboarding";
import {
  localProductRows,
  productRows,
  sourceCopy,
} from "../fixtures/source-onboarding";

const actionIcons: Record<string, LucideIcon> = {
  cloud: Cloud,
  link: Link,
  plug: Plug,
  plus: Plus,
};

const productArt: Record<string, ReactNode> = {
  Gemini: <Gemini data-brand width={24} height={24} />,
  Grok: <Grok data-brand width={24} height={24} />,
  Copilot: <Copilot data-brand width={24} height={24} />,
  "GitHub Copilot": <GithubCopilot data-brand width={24} height={24} />,
  "Qwen Code": <Qwen data-brand width={24} height={24} />,
  "Grok Bot": <img src={grokBot} width={24} height={24} alt="" />,
};

const remoteProducts = productRows.map(([label, brand]) => ({
  value: label,
  label,
  icon: productArt[label] ?? <BrandMark brand={brand as Brand} size={24} />,
  disabled: label === "Qwen Code",
  description: label === "Qwen Code" ? sourceCopy.unsupported : undefined,
}));

const localProducts = localProductRows.map(({ icon, brand, ...option }) => ({
  value: option.value,
  label: option.label,
  disabled: option.disabled,
  description: option.description,
  icon: icon ? (
    <Icon name={icon} size={24} />
  ) : (
    <BrandMark brand={brand as Brand} size={24} />
  ),
}));

export function SetupAction({
  icon,
  label,
  description,
  badge,
}: {
  icon: string;
  label: string;
  description?: string;
  badge?: string;
  catalog?: boolean;
}) {
  return (
    <SetupActionCard
      icon={actionIcons[icon] ?? Plus}
      label={label}
      description={description}
      badge={badge}
    />
  );
}

export function SourceOnboarding({ step }: { step: OnboardingStep }) {
  return (
    <LocaleProvider locale="zh-CN">
      <PrivacyProvider hidden>
        {step.body === "products" ? (
          <SourceProductPickerView
            value={sourceCopy.client}
            groups={[
              {
                id: "remote",
                label: sourceCopy.remote,
                options: remoteProducts,
              },
              {
                id: "local",
                label: sourceCopy.local,
                options: localProducts,
              },
            ]}
          />
        ) : step.body === "connection" ? (
          <SourceConnectionStepView
            prompt={sourceCopy.connectionQuestion}
            connectionsLabel="连接"
            selectedConnection="relay"
            hasSelectableConnection
            connections={sourceCopy.connectionOptions}
            emptyTitle={sourceCopy.noConnections}
            emptyPrompt={sourceCopy.connectionQuestion}
            emptyActions={null}
            addConnectionAction={
              <SetupAction
                icon="plus"
                label={sourceCopy.addConnection}
                description={sourceCopy.addDescription}
              />
            }
          />
        ) : step.body === "empty" ? (
          <SourceConnectionStepView
            connectionsLabel="连接"
            selectedConnection=""
            hasSelectableConnection={false}
            connections={[]}
            emptyTitle={sourceCopy.noConnections}
            emptyPrompt={sourceCopy.connectionQuestion}
            emptyActions={
              <div className="grid grid-cols-3 gap-2.5">
                {methods.map((method, i) => (
                  <SetupAction
                    key={method.value}
                    catalog
                    icon={sourceCopy.methodIcons[i]}
                    label={method.label}
                    badge={i === 0 ? sourceCopy.recommended : undefined}
                  />
                ))}
              </div>
            }
          />
        ) : step.body === "source-local" ? (
          <SourceAddressStepView
            isLocal
            localRestartText={sourceCopy.localRestart}
            copyStepTitle=""
            address=""
            copyAddressLabel=""
            configureStepTitle=""
            configurePath=""
            connectStepTitle=""
            connectStepNote=""
          />
        ) : step.body === "address" ? (
          <SourceAddressStepView
            copyStepTitle={sourceCopy.addressSteps[0]}
            address={maskedAddress}
            copyAddressLabel={sourceCopy.addressSteps[0]}
            configureStepTitle={sourceCopy.addressSteps[1]}
            configurePath={sourceCopy.settingsPath}
            openSettingsLabel={sourceCopy.openSettings}
            connectStepTitle={sourceCopy.addressSteps[2]}
            connectStepNote={sourceCopy.codeNotice}
          />
        ) : step.body === "approval" ? (
          <OAuthApprovalView
            pending
            inline
            pairingCode={sourceCopy.code}
            compareCodeLabel={sourceCopy.confirmCode}
            clientText={sourceCopy.scope.split(" · ")[0] ?? sourceCopy.scope}
            scopeText={sourceCopy.scope.split(" · ")[1] ?? ""}
            authorizationLabel={sourceCopy.account}
            authorizationValue="new"
            authorizationOptions={sourceCopy.accountOptions}
            showAccountName
            accountNameLabel={sourceCopy.accountName}
            accountName={sourceCopy.client}
          />
        ) : step.body === "success" ? (
          <SourceSuccessStepView
            title={sourceCopy.connected}
            subtitle={sourceCopy.relay}
            promptLabel={sourceCopy.tryPrompt}
            promptValue={sourceCopy.prompt}
            copyLabel={sourceCopy.tryPrompt}
          />
        ) : null}
      </PrivacyProvider>
    </LocaleProvider>
  );
}

export default () => [
  ...onboardingFrames
    .filter((step) => step.name.startsWith("source-"))
    .map((step) => (
      <Frame
        key={step.name}
        name={`source-onboarding-${step.body === "source-local" ? "local" : step.body}`}
        width={632}
      >
        <div className="w-full bg-surface-raised">
          <SourceOnboarding step={step} />
        </div>
      </Frame>
    )),
  <Frame key="setup-action" name="setup-action" width={632}>
    <div className="w-full bg-surface-raised">
      <SetupAction
        icon="plus"
        label={sourceCopy.addConnection}
        description={sourceCopy.addDescription}
      />
    </div>
  </Frame>,
];

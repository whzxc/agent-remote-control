import { Frame, Icon } from "adg";
import { Button } from "../components/button";
import { SingleChoice } from "../components/single-choice";
import { SetupChoice } from "../components/setup-choice";
import { CopyField } from "../components/copy-field";
import { Tile } from "../components/tile";
import { type Brand } from "../components/agent-icon";
import { OnboardingField, type OnboardingStep } from "./onboarding";
import { productRows, localProductRows, sourceCopy } from "../fixtures/source-onboarding";
import { onboardingFrames, methods, maskedAddress } from "../fixtures/onboarding";
import Gemini from "../art/gemini.svg";
import Grok from "../art/grok.svg";
import Copilot from "../art/microsoft-copilot.svg";
import GithubCopilot from "../art/github-copilot.svg";
import Qwen from "../art/qwen-code.svg";
import grokBot from "../art/grok-bot.png";

const productArt: Record<string, unknown> = {
  Gemini: <Gemini data-brand width={24} height={24} />,
  Grok: <Grok data-brand width={24} height={24} />,
  Copilot: <Copilot data-brand width={24} height={24} />,
  "GitHub Copilot": <GithubCopilot data-brand width={24} height={24} />,
  "Qwen Code": <Qwen data-brand width={24} height={24} />,
  "Grok Bot": <img src={grokBot} width={24} height={24} />,
};
const products = productRows.map(([label, brand]) => ({
  value: label,
  label,
  brand: brand as Brand,
  graphic: productArt[label],
  disabled: label === "Qwen Code",
  ...(label === "Qwen Code" ? { description: sourceCopy.unsupported } : {}),
}));
const localProducts = localProductRows.map(({ icon, ...option }) => ({
  ...option, brand: option.brand as Brand,
  graphic: icon ? <Icon name={icon} size={24} /> : undefined,
}));
export function SetupAction(props: {
  icon: string;
  label: string;
  description?: string;
  badge?: string;
  catalog?: boolean;
}) {
  return <SetupChoice {...props} />;
}
export function SourceOnboarding({ step }: { step: OnboardingStep }) {
  switch (step.body) {
    case "products":
      return (
        <div class="flex flex-col gap-[10px]">
          <h3 class="text-meta leading-4 text-text-tertiary">{sourceCopy.remote}</h3>
          <div class="pt-[2px]">
            <SingleChoice
              label={sourceCopy.remote}
              value={sourceCopy.client}
              options={products}
              form="setup-product"
              catalog
            />
          </div>
          <h3 class="text-meta leading-4 text-text-tertiary">{sourceCopy.local}</h3>
          <div class="pt-[2px]">
            <SingleChoice
              label={sourceCopy.local}
              value=""
              options={localProducts}
              form="setup-product"
              catalog
            />
          </div>
        </div>
      );
    case "connection":
      return (
        <div class="flex flex-col gap-4">
          <p class="text-body leading-4 text-text-secondary mb-1">{sourceCopy.connectionQuestion}</p>
          <SingleChoice
            label="连接"
            value="relay"
            form="setup-row"
            options={sourceCopy.connectionOptions}
          />
          <SetupAction
            icon="plus"
            label={sourceCopy.addConnection}
            description={sourceCopy.addDescription}
          />
        </div>
      );
    case "empty":
      return (
        <div class="flex flex-col gap-3">
          <h3 class="text-body leading-4 font-[650]">{sourceCopy.noConnections}</h3>
          <p class="text-body leading-4 text-text-secondary">{sourceCopy.connectionQuestion}</p>
          <div class="grid grid-cols-3 gap-[10px] mt-2">
            {methods.map((method, i) => (
              <div>
                <SetupAction
                  catalog
                  icon={sourceCopy.methodIcons[i]}
                  label={method.label}
                  badge={i === 0 ? sourceCopy.recommended : undefined}
                />
              </div>
            ))}
          </div>
        </div>
      );
    case "source-local":
      return <p class="text-body leading-6">{sourceCopy.localRestart}</p>;
    case "address":
      return (
        <div class="flex flex-col gap-7">
          {sourceCopy.addressSteps.map(
            (title, i) => (
              <section class="flex gap-[14px]">
                <span class="grid size-6 shrink-0 place-items-center rounded-control bg-surface-sunken text-meta font-semibold">
                  {i + 1}
                </span>
                <div
                  class={`flex flex-1 flex-col ${i === 0 ? "gap-3" : "gap-[6px]"}`}
                >
                  <h3 class="text-body leading-6 font-[650]">{title}</h3>
                  {i === 0 ? (
                    <div>
                      <CopyField value={maskedAddress} masked />
                    </div>
                  ) : i === 1 ? (
                    <div class="flex items-center gap-4">
                      <p class="text-small text-text-secondary">{sourceCopy.settingsPath}</p>
                      <Button icon="external-link">{sourceCopy.openSettings}</Button>
                    </div>
                  ) : (
                    <p class="text-small leading-4 text-text-secondary">{sourceCopy.codeNotice}</p>
                  )}
                </div>
              </section>
            ),
          )}
        </div>
      );
    case "approval":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-6 rounded-card bg-surface-subtle px-5 py-[18px]">
            <div class="flex items-center gap-6">
              <strong class="font-mono text-[28px] leading-5">{sourceCopy.code}</strong>
              <p class="text-small">{sourceCopy.confirmCode}</p>
            </div>
            <p class="text-small leading-4 text-text-secondary">{sourceCopy.scope}</p>
          </div>
          <SingleChoice
            label={sourceCopy.account}
            value="new"
            fill
            options={sourceCopy.accountOptions}
          />
          <OnboardingField label={sourceCopy.accountName} value={sourceCopy.client} />
        </div>
      );
    case "success":
      return (
        <div class="flex flex-col gap-6">
          <div class="flex items-center gap-4">
            <Tile icon="check" tone="success" />
            <div class="flex flex-col gap-[10px]">
              <h3 class="text-title leading-5 font-[650]">{sourceCopy.connected}</h3>
              <p class="text-meta leading-4 text-text-secondary">{sourceCopy.relay}</p>
            </div>
          </div>
          <div class="flex flex-col gap-6">
            <p class="text-small leading-4 font-semibold">{sourceCopy.tryPrompt}</p>
            <CopyField value={sourceCopy.prompt} masked />
          </div>
        </div>
      );
    default: return null;
  }
}
export default () => [
  ...onboardingFrames.filter(step => step.name.startsWith("source-")).map(step => (
    <Frame name={`source-onboarding-${step.body === "source-local" ? "local" : step.body}`} width={632}>
      <div class="w-full bg-surface-raised"><SourceOnboarding step={step} /></div>
    </Frame>
  )),
  <Frame name="setup-action" width={632}>
    <div class="w-full bg-surface-raised">
      <SetupAction icon="plus" label={sourceCopy.addConnection} description={sourceCopy.addDescription} />
    </div>
  </Frame>,
];

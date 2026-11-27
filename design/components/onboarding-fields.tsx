import { Frame } from 'adg';
import { SingleChoice } from './single-choice';
import { Field, Input } from './field';
import { connectionCopy } from '../fixtures/connection-onboarding';


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
  className: extra = "",
}: {
  label: string;
  options: string[];
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 ${extra}`}>
      <h3 className="text-small leading-4 font-semibold">{label}</h3>
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
        <span className="flex items-center gap-3">
          {label}
          {action && <span className="font-semibold">{action}</span>}
        </span>
      }
    >
      <Input value={value} />
    </Field>
  );
}

export default () => [
  <Frame name="onboarding-choice-field" width={632}>
    <div className="w-full bg-surface-raised">
      <OnboardingChoiceField label={connectionCopy.https} options={connectionCopy.providers} value={connectionCopy.provider} />
    </div>
  </Frame>,
  <Frame name="onboarding-field" width={308}>
    <div className="w-full bg-surface-raised"><OnboardingField label={connectionCopy.domainLabel} value={connectionCopy.domain} /></div>
  </Frame>,
];

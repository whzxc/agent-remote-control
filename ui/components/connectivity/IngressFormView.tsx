import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Field } from "../kit/field";
import { SegmentedControl, type SegmentedOption } from "../kit/segmented-control";
import { cn } from "../kit/utils";

export interface IngressChoiceFieldConfig {
  label: string;
  ariaLabel?: string;
  value: string;
  options: readonly SegmentedOption<string>[];
  onChange?: (value: string) => void;
  equal?: boolean;
}

export interface IngressFormViewProps {
  setupLayout?: boolean;
  disabled?: boolean;
  topNameField?: ReactNode;
  connectionMode?: IngressChoiceFieldConfig;
  https: boolean;
  tunnelFields?: ReactNode;
  httpsProvider?: IngressChoiceFieldConfig;
  domainMode?: IngressChoiceFieldConfig;
  cloudflareManagedNotice?: string;
  domainField?: ReactNode;
  setupNameField?: ReactNode;
  credentialField?: ReactNode;
  authentication?: IngressChoiceFieldConfig;
  toolPolicyField?: ReactNode;
  error?: string;
  className?: string;
}

export function IngressFormView({
  setupLayout = false,
  disabled = false,
  topNameField,
  connectionMode,
  https,
  tunnelFields,
  httpsProvider,
  domainMode,
  cloudflareManagedNotice,
  domainField,
  setupNameField,
  credentialField,
  authentication,
  toolPolicyField,
  error,
  className,
}: IngressFormViewProps): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-5", className)}>
      {!setupLayout && topNameField}
      {connectionMode && (
        <Field label={connectionMode.label}>
          <SegmentedControl
            equal={connectionMode.equal ?? setupLayout}
            className={setupLayout ? "w-full" : undefined}
            aria-label={connectionMode.ariaLabel ?? connectionMode.label}
            value={connectionMode.value}
            onValueChange={connectionMode.onChange}
            disabled={disabled}
            options={connectionMode.options}
          />
        </Field>
      )}
      {!https ? (
        <>
          {tunnelFields}
          {setupLayout && setupNameField}
          {toolPolicyField}
        </>
      ) : (
        <>
          {httpsProvider && (
            <Field label={httpsProvider.label}>
              <SegmentedControl
                equal={httpsProvider.equal ?? setupLayout}
                className={setupLayout ? "w-full" : undefined}
                aria-label={httpsProvider.ariaLabel ?? httpsProvider.label}
                value={httpsProvider.value}
                onValueChange={httpsProvider.onChange}
                disabled={disabled}
                options={httpsProvider.options}
              />
            </Field>
          )}
          {domainMode && (
            <Field label={domainMode.label}>
              <SegmentedControl
                equal={domainMode.equal ?? setupLayout}
                className={setupLayout ? "w-full" : undefined}
                aria-label={domainMode.ariaLabel ?? domainMode.label}
                value={domainMode.value}
                onValueChange={domainMode.onChange}
                disabled={disabled}
                options={domainMode.options}
              />
            </Field>
          )}
          {cloudflareManagedNotice && (
            <Alert tone="info">{cloudflareManagedNotice}</Alert>
          )}
          {(domainField || (setupLayout && setupNameField)) && (
            <div
              className={cn(
                "grid min-w-0 gap-4",
                setupLayout &&
                  domainField &&
                  setupNameField &&
                  "grid-cols-2 max-[540px]:grid-cols-1",
              )}
            >
              {domainField}
              {setupLayout && setupNameField}
            </div>
          )}
          {credentialField}
          {authentication && (
            <Field label={authentication.label}>
              <SegmentedControl
                equal={authentication.equal ?? setupLayout}
                className={setupLayout ? "w-full" : undefined}
                aria-label={authentication.ariaLabel ?? authentication.label}
                value={authentication.value}
                onValueChange={authentication.onChange}
                disabled={disabled}
                options={authentication.options}
              />
            </Field>
          )}
          {toolPolicyField}
        </>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

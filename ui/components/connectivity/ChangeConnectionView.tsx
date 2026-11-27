import { ExternalLink } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { CopyField } from "../kit/copy-field";
import { Field } from "../kit/field";
import { RadioCard, RadioGroup } from "../kit/radio-group";
import { cn } from "../kit/utils";

export interface SwitchConnectionOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function ChangeConnectionPickView({
  currentSummary,
  connectionsLabel,
  connections,
  selectedId,
  onSelect,
  disabled = false,
  addConnectionAction,
  warningMessage,
  className,
}: {
  currentSummary: string;
  connectionsLabel: string;
  connections: readonly SwitchConnectionOption[];
  selectedId: string;
  onSelect?: (id: string) => void;
  disabled?: boolean;
  addConnectionAction?: ReactNode;
  warningMessage: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      <p className="m-0 text-small leading-5 text-text-secondary">
        {currentSummary}
      </p>
      <RadioGroup
        aria-label={connectionsLabel}
        value={selectedId}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") onSelect?.(next);
        }}
      >
        {connections.map((option) => (
          <RadioCard
            key={option.value}
            value={option.value}
            title={option.label}
            description={option.description}
            disabled={option.disabled}
          />
        ))}
      </RadioGroup>
      {addConnectionAction}
      <Alert tone="warning">{warningMessage}</Alert>
    </div>
  );
}

export function ChangeConnectionAddressView({
  address,
  copyAddressLabel,
  bearerLabel,
  bearerValue,
  bearerField,
  step,
  addressInstruction,
  configureTitle,
  configurePath,
  openSettingsLabel,
  onOpenSettings,
  browserCodeNote,
  retryLabel,
  retryBusy = false,
  onRetry,
  approvalContent,
  removedMessage,
  expiredMessage,
  className,
}: {
  address?: string;
  copyAddressLabel: string;
  bearerLabel?: string;
  bearerValue?: string;
  bearerField?: ReactNode;
  step: "address" | "approval";
  addressInstruction: string;
  configureTitle: string;
  configurePath: string;
  openSettingsLabel?: string;
  onOpenSettings?: () => void;
  browserCodeNote: string;
  retryLabel?: string;
  retryBusy?: boolean;
  onRetry?: () => void;
  approvalContent?: ReactNode;
  removedMessage?: string;
  expiredMessage?: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      {removedMessage ? (
        <Alert tone="danger">{removedMessage}</Alert>
      ) : (
        <>
          {address !== undefined && (
            <CopyField
              value={address}
              label={copyAddressLabel}
              className="w-full"
            />
          )}
          {bearerField ??
            (bearerValue && bearerLabel && (
              <Field label={bearerLabel}>
                <CopyField
                  password
                  value={bearerValue}
                  label={bearerLabel}
                  className="w-full"
                />
              </Field>
            ))}
          {step === "address" && (
            <div className="grid min-w-0 gap-2.5">
              <p className="m-0 text-small leading-5 text-foreground">
                {addressInstruction}
              </p>
              <h3 className="m-0 text-body leading-5 font-semibold text-foreground">
                {configureTitle}
              </h3>
              <p className="m-0 text-small leading-5 text-text-secondary">
                {configurePath}
              </p>
              {openSettingsLabel && (
                <div>
                  <Button variant="outline" size="sm" onClick={onOpenSettings}>
                    <ExternalLink
                      size={14}
                      strokeWidth={1.75}
                      absoluteStrokeWidth
                      aria-hidden="true"
                    />
                    {openSettingsLabel}
                  </Button>
                </div>
              )}
              <p className="m-0 text-small leading-5 text-text-secondary">
                {browserCodeNote}
              </p>
              {onRetry && retryLabel && (
                <div>
                  <Button busy={retryBusy} onClick={onRetry}>
                    {retryLabel}
                  </Button>
                </div>
              )}
            </div>
          )}
          {step === "approval" && approvalContent}
        </>
      )}
      {expiredMessage && <Alert tone="warning">{expiredMessage}</Alert>}
    </div>
  );
}

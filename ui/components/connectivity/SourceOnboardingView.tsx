import { Check, ExternalLink } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { CopyField } from "../kit/copy-field";
import { Field } from "../kit/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { cn } from "../kit/utils";

export {
  SetupActionCard,
  SourceConnectionStepView,
  SourceProductPickerView,
  type SetupActionCardProps,
  type SourceConnectionOption,
  type SourceProductGroup,
  type SourceProductOption,
} from "./SourceOnboardingPickerView";

export function SourceAddressStepView({
  isLocal = false,
  localRestartText,
  copyStepTitle,
  address,
  copyAddressLabel,
  bearerLabel,
  bearerValue,
  bearerField,
  configureStepTitle,
  configurePath,
  openSettingsLabel,
  onOpenSettings,
  connectStepTitle,
  connectStepNote,
  error,
  retryLabel,
  retryBusy = false,
  retryDisabled = false,
  onRetry,
  reviewLabel,
  onReview,
  className,
}: {
  isLocal?: boolean;
  localRestartText?: string;
  copyStepTitle: string;
  address: string;
  copyAddressLabel: string;
  bearerLabel?: string;
  bearerValue?: string;
  bearerField?: ReactNode;
  configureStepTitle: string;
  configurePath: string;
  openSettingsLabel?: string;
  onOpenSettings?: () => void;
  connectStepTitle: string;
  connectStepNote: string;
  error?: string;
  retryLabel?: string;
  retryBusy?: boolean;
  retryDisabled?: boolean;
  onRetry?: () => void;
  reviewLabel?: string;
  onReview?: () => void;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-5", className)}>
      {isLocal ? (
        <p className="m-0 text-body leading-6 text-foreground">
          {localRestartText}
        </p>
      ) : (
        <ol className="m-0 grid list-none gap-6 p-0">
          <li className="flex min-w-0 gap-3.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-meta font-semibold text-foreground tabular-nums">
              1
            </span>
            <div className="grid min-w-0 flex-1 gap-2.5">
              <strong className="text-body leading-6 font-semibold text-foreground">
                {copyStepTitle}
              </strong>
              <CopyField
                value={address}
                label={copyAddressLabel}
                className="w-full"
              />
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
            </div>
          </li>
          <li className="flex min-w-0 gap-3.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-meta font-semibold text-foreground tabular-nums">
              2
            </span>
            <div className="grid min-w-0 flex-1 gap-2">
              <strong className="text-body leading-6 font-semibold text-foreground">
                {configureStepTitle}
              </strong>
              <div className="flex flex-wrap items-center gap-3">
                <p className="m-0 text-small leading-5 text-text-secondary">
                  {configurePath}
                </p>
                {openSettingsLabel && (
                  <Button variant="outline" size="sm" onClick={onOpenSettings}>
                    <ExternalLink
                      size={14}
                      strokeWidth={1.75}
                      absoluteStrokeWidth
                      aria-hidden="true"
                    />
                    {openSettingsLabel}
                  </Button>
                )}
              </div>
            </div>
          </li>
          <li className="flex min-w-0 gap-3.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-meta font-semibold text-foreground tabular-nums">
              3
            </span>
            <div className="grid min-w-0 flex-1 gap-1.5">
              <strong className="text-body leading-6 font-semibold text-foreground">
                {connectStepTitle}
              </strong>
              <p className="m-0 text-small leading-5 text-text-secondary">
                {connectStepNote}
              </p>
            </div>
          </li>
        </ol>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {(onRetry || onReview) && (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && retryLabel && (
            <Button
              disabled={retryDisabled}
              busy={retryBusy}
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          )}
          {onReview && reviewLabel && (
            <Button onClick={onReview}>{reviewLabel}</Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SourceApprovalStepView({
  pendingRequests = [],
  pendingRequestsLabel = "Pending requests",
  selectedRequestId = "",
  onSelectRequest,
  children,
  expiredMessage,
  retryLabel,
  onRetry,
  className,
}: {
  pendingRequests?: readonly { id: string; label: string }[];
  pendingRequestsLabel?: string;
  selectedRequestId?: string;
  onSelectRequest?: (id: string) => void;
  children?: ReactNode;
  expiredMessage?: string;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}): ReactElement {
  const selectedLabel =
    pendingRequests.find((item) => item.id === selectedRequestId)?.label ?? "";

  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      {pendingRequests.length > 1 && (
        <Field label={pendingRequestsLabel}>
          <Select
            value={selectedRequestId}
            onValueChange={(next) => {
              if (typeof next === "string") onSelectRequest?.(next);
            }}
          >
            <SelectTrigger
              aria-label={pendingRequestsLabel}
              className="w-full"
            >
              <SelectValue placeholder={pendingRequestsLabel}>
                {selectedLabel || pendingRequestsLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {pendingRequests.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}
      {children ??
        (expiredMessage && <Alert tone="warning">{expiredMessage}</Alert>)}
      {onRetry && retryLabel && (
        <div>
          <Button onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  );
}

export function SourceSuccessStepView({
  title,
  subtitle,
  promptLabel,
  promptValue,
  copyLabel,
  className,
}: {
  title: string;
  subtitle: string;
  promptLabel: string;
  promptValue: string;
  copyLabel: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-6", className)}>
      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-tile bg-success/12 text-success"
        >
          <Check size={18} strokeWidth={2} absoluteStrokeWidth />
        </span>
        <div className="grid min-w-0 gap-1">
          <h3 className="m-0 text-title leading-6 font-semibold text-foreground">
            {title}
          </h3>
          <p className="m-0 text-small leading-4 text-text-secondary">
            {subtitle}
          </p>
        </div>
      </div>
      <Field label={promptLabel}>
        <CopyField value={promptValue} label={copyLabel} className="w-full" />
      </Field>
    </div>
  );
}

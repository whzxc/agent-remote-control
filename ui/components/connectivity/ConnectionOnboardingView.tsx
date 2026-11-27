import { Check } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Badge } from "../kit/badge";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import { CopyField } from "../kit/copy-field";
import { Field } from "../kit/field";
import { Input } from "../kit/input";
import { RadioCard, RadioGroup } from "../kit/radio-group";
import { Loading } from "../kit/spinner";
import { cn } from "../kit/utils";

export interface ConnectionMethodOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function ConnectionMethodStepView({
  label,
  value,
  options,
  secondaryFrom,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly ConnectionMethodOption[];
  secondaryFrom?: number;
  onChange?: (value: string) => void;
  className?: string;
}): ReactElement {
  const hasSecondary =
    secondaryFrom !== undefined && options.length > secondaryFrom;
  const primary = hasSecondary ? options.slice(0, secondaryFrom) : options;
  const secondary = hasSecondary ? options.slice(secondaryFrom) : [];

  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange?.(next);
      }}
      className={cn("grid min-w-0 gap-3", className)}
    >
      {primary.map((option) => (
        <RadioCard
          key={option.value}
          value={option.value}
          title={option.label}
          description={option.description}
          disabled={option.disabled}
        />
      ))}
      {secondary.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-2.5 max-[520px]:grid-cols-1">
          {secondary.map((option) => (
            <RadioCard
              key={option.value}
              value={option.value}
              title={option.label}
              description={option.description}
              disabled={option.disabled}
              className="items-center"
            />
          ))}
        </div>
      )}
    </RadioGroup>
  );
}

export function ConnectionJoinStepView({
  linkId,
  linkLabel,
  linkValue,
  onLinkChange,
  linkInput,
  deviceId,
  deviceLabel,
  deviceValue,
  onDeviceChange,
  visibilityHint,
  className,
}: {
  linkId?: string;
  linkLabel: string;
  linkValue?: string;
  onLinkChange?: (value: string) => void;
  linkInput?: ReactNode;
  deviceId?: string;
  deviceLabel: string;
  deviceValue: string;
  onDeviceChange?: (value: string) => void;
  visibilityHint: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-5", className)}>
      <Field id={linkId} label={linkLabel}>
        {linkInput ?? (
          <Input
            id={linkId}
            type="url"
            required
            value={linkValue ?? ""}
            onChange={(event) => onLinkChange?.(event.target.value)}
          />
        )}
      </Field>
      <div className="grid min-w-0 gap-1.5">
        <Field id={deviceId} label={deviceLabel}>
          <Input
            id={deviceId}
            required
            value={deviceValue}
            onChange={(event) => onDeviceChange?.(event.target.value)}
          />
        </Field>
        <p className="m-0 text-meta leading-4 text-text-secondary">
          {visibilityHint}
        </p>
      </div>
    </div>
  );
}

export function ConnectionLocalStepView({
  description,
  loading = false,
  retryLabel,
  retryBusy = false,
  onRetry,
  unavailableWarning,
  revokedWarning,
  className,
}: {
  description: string;
  loading?: boolean;
  retryLabel?: string;
  retryBusy?: boolean;
  onRetry?: () => void;
  unavailableWarning?: string;
  revokedWarning?: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      <p className="m-0 text-body leading-6 text-foreground">{description}</p>
      {loading && <Loading />}
      {onRetry && retryLabel && (
        <div>
          <Button busy={retryBusy} onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
      {unavailableWarning && <Alert tone="warning">{unavailableWarning}</Alert>}
      {revokedWarning && <Alert tone="warning">{revokedWarning}</Alert>}
    </div>
  );
}

export function ConnectionReadyStepView({
  heading,
  connection,
  restartHint,
  error,
  retryLabel,
  retryBusy = false,
  onRetry,
  className,
}: {
  heading: string;
  connection?: {
    name: string;
    online: boolean;
    statusLabel: string;
    sourceCountLabel: string;
    kindLabel: string;
    address?: string;
    copyAddressLabel: string;
  };
  restartHint?: string;
  error?: string;
  retryLabel?: string;
  retryBusy?: boolean;
  onRetry?: () => void;
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
        <h3 className="m-0 text-title leading-6 font-semibold text-foreground">
          {heading}
        </h3>
      </div>
      {connection && (
        <Card padded className="gap-5 bg-surface-subtle">
          <div className="grid min-w-0 gap-2">
            <strong className="text-body leading-5 font-semibold text-foreground">
              {connection.name}
            </strong>
            <div className="flex flex-wrap items-center gap-2 text-meta leading-4 text-text-secondary">
              <Badge
                tone={connection.online ? "success" : "neutral"}
                size="sm"
                dot
              >
                {connection.statusLabel}
              </Badge>
              <span aria-hidden="true" className="text-text-tertiary">
                ·
              </span>
              <span className="tabular-nums">{connection.sourceCountLabel}</span>
            </div>
          </div>
          <div className="grid min-w-0 gap-2">
            <span className="text-small leading-4 text-text-secondary">
              {connection.kindLabel}
            </span>
            {connection.address && (
              <CopyField
                value={connection.address}
                label={connection.copyAddressLabel}
                className="w-full"
              />
            )}
          </div>
        </Card>
      )}
      {restartHint && (
        <p className="m-0 text-small leading-5 text-text-secondary">
          {restartHint}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {onRetry && retryLabel && (
        <div>
          <Button busy={retryBusy} onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

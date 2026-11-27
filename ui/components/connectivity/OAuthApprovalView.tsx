import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Badge } from "../kit/badge";
import { Button } from "../kit/button";
import { Card } from "../kit/card";
import { Field } from "../kit/field";
import { Input } from "../kit/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { cn } from "../kit/utils";

export interface OAuthCandidateOption {
  value: string;
  label: string;
}

export interface OAuthApprovalViewProps {
  pending: boolean;
  statusMessage?: string;
  inline?: boolean;
  pairingCode: string;
  compareCodeLabel: string;
  clientText: string;
  scopeText: string;
  switchClaimLabel?: string;
  switchSummary?: string;
  authorizationLabel?: string;
  authorizationValue?: string;
  authorizationOptions?: readonly OAuthCandidateOption[];
  onAuthorizationChange?: (value: string) => void;
  showAccountName?: boolean;
  accountNameId?: string;
  accountNameLabel?: string;
  accountName?: string;
  accountNameError?: string;
  onAccountNameChange?: (value: string) => void;
  disabled?: boolean;
  busy?: boolean;
  denyLabel?: string;
  allowLabel?: string;
  allowDisabled?: boolean;
  onDeny?: () => void;
  onAllow?: () => void;
  actionsWrapper?: (actions: ReactNode) => ReactNode;
  error?: string;
  className?: string;
}

export function OAuthApprovalView({
  pending,
  statusMessage,
  inline = false,
  pairingCode,
  compareCodeLabel,
  clientText,
  scopeText,
  switchClaimLabel,
  switchSummary,
  authorizationLabel = "Account",
  authorizationValue = "new",
  authorizationOptions = [],
  onAuthorizationChange,
  showAccountName = false,
  accountNameId,
  accountNameLabel = "Account name",
  accountName = "",
  accountNameError,
  onAccountNameChange,
  disabled = false,
  busy = false,
  denyLabel = "Deny",
  allowLabel = "Allow",
  allowDisabled = false,
  onDeny,
  onAllow,
  actionsWrapper,
  error,
  className,
}: OAuthApprovalViewProps): ReactElement {
  const selectedAuthLabel =
    authorizationOptions.find((item) => item.value === authorizationValue)
      ?.label ?? "";

  const nonInlineActions = !inline ? (
    <>
      <Button disabled={disabled || busy} onClick={onDeny}>
        {denyLabel}
      </Button>
      <Button
        variant="primary"
        busy={busy}
        disabled={disabled || allowDisabled}
        onClick={onAllow}
      >
        {allowLabel}
      </Button>
    </>
  ) : null;

  return (
    <div className={cn("grid min-w-0 gap-5", className)}>
      {pending ? (
        <>
          {inline ? (
            <Card padded className="gap-4 bg-surface-subtle">
              <div className="flex flex-wrap items-center gap-6">
                <strong className="font-mono text-[28px] leading-7 font-semibold tracking-wider text-foreground tabular-nums">
                  {pairingCode}
                </strong>
                <span className="text-small leading-5 text-foreground">
                  {compareCodeLabel}
                </span>
              </div>
              <p className="m-0 text-meta leading-4 text-text-secondary">
                {clientText} · {scopeText}
              </p>
            </Card>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-kit-card border border-border bg-surface-subtle px-4 py-3.5">
              <span className="text-small text-text-secondary">
                {compareCodeLabel}
              </span>
              <strong className="font-mono text-[24px] leading-7 font-semibold tracking-wider text-foreground tabular-nums">
                {pairingCode}
              </strong>
            </div>
          )}

          {switchClaimLabel && (
            <div className="grid gap-2">
              <div>
                <Badge tone="accent">{switchClaimLabel}</Badge>
              </div>
              {switchSummary && (
                <p className="m-0 text-small leading-5 text-text-secondary">
                  {switchSummary}
                </p>
              )}
            </div>
          )}

          {authorizationOptions.length > 0 && (
            <Field label={authorizationLabel}>
              <Select
                value={authorizationValue}
                disabled={disabled || busy}
                onValueChange={(next) => {
                  if (typeof next === "string") onAuthorizationChange?.(next);
                }}
              >
                <SelectTrigger
                  aria-label={authorizationLabel}
                  className="w-full"
                >
                  <SelectValue placeholder={authorizationLabel}>
                    {selectedAuthLabel || authorizationLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {authorizationOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          )}

          {showAccountName && (
            <Field
              id={accountNameId}
              label={accountNameLabel}
              error={accountNameError}
            >
              <Input
                id={accountNameId}
                value={accountName}
                disabled={disabled || busy}
                aria-invalid={!!accountNameError || undefined}
                aria-describedby={
                  accountNameError && accountNameId
                    ? `${accountNameId}-error`
                    : undefined
                }
                onChange={(event) => onAccountNameChange?.(event.target.value)}
              />
            </Field>
          )}

          {!inline && (
            <div className="grid gap-1 text-meta leading-4 text-text-secondary">
              <p className="m-0">{clientText}</p>
              <p className="m-0">{scopeText}</p>
            </div>
          )}

          {nonInlineActions &&
            (actionsWrapper ? (
              actionsWrapper(nonInlineActions)
            ) : (
              <div className="flex items-center justify-end gap-2">
                {nonInlineActions}
              </div>
            ))}
        </>
      ) : (
        statusMessage && (
          <p className="m-0 text-small leading-5 text-text-secondary">
            {statusMessage}
          </p>
        )
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

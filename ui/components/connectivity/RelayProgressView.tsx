import { Check, Circle } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { Field } from "../kit/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../kit/select";
import { Spinner } from "../kit/spinner";
import { cn } from "../kit/utils";

export interface RelayProgressStep {
  id: string;
  label: string;
  detail?: string;
  state: "complete" | "running" | "waiting";
}

export interface RelayAccountOption {
  id: string;
  label: string;
}

export interface RelayProgressViewProps {
  failed?: boolean;
  failureMessage?: string;
  accounts?: readonly RelayAccountOption[];
  selectedAccount?: string;
  chooseAccountLabel?: string;
  onSelectAccount?: (id: string) => void;
  retryLabel?: string;
  retryBusy?: boolean;
  retryDisabled?: boolean;
  onRetry?: () => void;
  steps: readonly RelayProgressStep[];
  copyLoginLabel?: string;
  onCopyLogin?: () => void;
  footer?: ReactNode;
  className?: string;
}

export function RelayProgressView({
  failed = false,
  failureMessage,
  accounts = [],
  selectedAccount = "",
  chooseAccountLabel = "Account",
  onSelectAccount,
  retryLabel = "Retry",
  retryBusy = false,
  retryDisabled = false,
  onRetry,
  steps,
  copyLoginLabel,
  onCopyLogin,
  footer,
  className,
}: RelayProgressViewProps): ReactElement {
  const selectedLabel =
    accounts.find((item) => item.id === selectedAccount)?.label ?? "";

  return (
    <div className={cn("grid min-w-0 gap-5", className)}>
      {failed ? (
        <div className="grid min-w-0 gap-4">
          {failureMessage && <Alert tone="danger">{failureMessage}</Alert>}
          {accounts.length > 0 && (
            <Field label={chooseAccountLabel}>
              <Select
                value={selectedAccount}
                onValueChange={(next) => {
                  if (typeof next === "string") onSelectAccount?.(next);
                }}
              >
                <SelectTrigger
                  aria-label={chooseAccountLabel}
                  className="w-full"
                >
                  <SelectValue placeholder={chooseAccountLabel}>
                    {selectedLabel || chooseAccountLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          )}
          <div>
            <Button
              variant="primary"
              busy={retryBusy}
              disabled={retryDisabled}
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          </div>
        </div>
      ) : (
        <ol className="m-0 grid list-none gap-5 p-0">
          {steps.map((step) => (
            <li
              key={step.id}
              aria-current={step.state === "running" ? "step" : undefined}
              className="flex min-h-10 items-center gap-4"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-tile",
                  step.state === "complete"
                    ? "bg-success/12 text-success"
                    : step.state === "running"
                      ? "bg-accent/12 text-accent"
                      : "bg-surface-subtle text-text-tertiary",
                )}
              >
                {step.state === "complete" ? (
                  <Check size={18} strokeWidth={2} absoluteStrokeWidth />
                ) : step.state === "running" ? (
                  <Spinner size={18} />
                ) : (
                  <Circle size={18} strokeWidth={1.75} absoluteStrokeWidth />
                )}
              </span>
              <div className="grid min-w-0 gap-1">
                <strong className="text-body leading-5 font-semibold text-foreground">
                  {step.label}
                </strong>
                {step.detail && (
                  <small className="text-meta leading-4 text-text-secondary">
                    {step.detail}
                  </small>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {copyLoginLabel && (
        <div>
          <Button variant="ghost" onClick={onCopyLogin}>
            {copyLoginLabel}
          </Button>
        </div>
      )}
      {footer}
    </div>
  );
}

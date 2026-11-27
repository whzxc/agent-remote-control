import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { cn } from "../kit/utils";

export interface HubRecoveryFaultItem {
  id: string;
  label: string;
  busy?: boolean;
  onRestart?: () => void;
}

export interface HubRecoveryViewProps {
  reason: string;
  impact?: ReactNode;
  faults?: readonly HubRecoveryFaultItem[];
  busy?: boolean;
  error?: string;
  className?: string;
}

export function HubRecoveryView({
  reason,
  impact,
  faults = [],
  busy = false,
  error,
  className,
}: HubRecoveryViewProps): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-3", className)}>
      <p className="m-0 text-body leading-5 text-foreground">{reason}</p>
      {impact}
      {faults.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {faults.map((fault) => (
            <Button
              key={fault.id}
              disabled={busy}
              busy={fault.busy}
              onClick={fault.onRestart}
            >
              {fault.label}
            </Button>
          ))}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

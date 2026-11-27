import { Pencil, Trash2, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "./kit/alert";
import { Badge } from "./kit/badge";
import { IconButton } from "./kit/button";
import { CopyField } from "./kit/copy-field";
import { cn } from "./kit/utils";
import { Card, CardContent, CardHeader } from "./ui/card";

export interface ConnectionSourceChip {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface ConnectionFactsViewProps {
  providerLabel: string;
  providerValue: string;
  methodLabel: string;
  methodValue: string;
  workerVersion?: string;
  className?: string;
}

export function ConnectionFactsView({
  providerLabel,
  providerValue,
  methodLabel,
  methodValue,
  workerVersion,
  className,
}: ConnectionFactsViewProps): ReactElement {
  return (
    <dl className={cn("m-0 grid grid-cols-2 gap-3", className)}>
      <div className="grid min-w-0 gap-1">
        <dt className="text-meta leading-4 text-text-secondary">
          {providerLabel}
        </dt>
        <dd className="m-0 min-w-0 wrap-anywhere text-small leading-5 font-medium text-foreground">
          {providerValue}
        </dd>
        {workerVersion && (
          <p className="m-0 text-meta leading-4 text-text-tertiary tabular-nums">
            {workerVersion}
          </p>
        )}
      </div>
      <div className="grid min-w-0 gap-1">
        <dt className="text-meta leading-4 text-text-secondary">
          {methodLabel}
        </dt>
        <dd className="m-0 min-w-0 wrap-anywhere text-small leading-5 font-medium text-foreground">
          {methodValue}
        </dd>
      </div>
    </dl>
  );
}

export interface ConnectionCardViewProps {
  title: string;
  online: boolean;
  statusLabel: string;
  icon: LucideIcon;
  iconTone?: "accent" | "command" | "neutral";
  sources?: readonly ConnectionSourceChip[];
  address?: string;
  copyAddressLabel?: string;
  providerLabel: string;
  providerValue: string;
  methodLabel: string;
  methodValue: string;
  workerVersion?: string;
  error?: string;
  canEdit?: boolean;
  editLabel?: string;
  onEdit?: () => void;
  removeLabel?: string;
  onRemove?: () => void;
  actionsDisabled?: boolean;
  footer?: ReactNode;
  className?: string;
}

const iconToneClasses = {
  accent: "bg-accent/12 text-accent",
  command: "bg-phase-command/12 text-phase-command",
  neutral: "bg-surface-subtle text-text-secondary",
} as const;

export function ConnectionCardView({
  title,
  online,
  statusLabel,
  icon: IconComponent,
  iconTone = "accent",
  sources = [],
  address,
  copyAddressLabel = "Copy address",
  providerLabel,
  providerValue,
  methodLabel,
  methodValue,
  workerVersion,
  error,
  canEdit = false,
  editLabel,
  onEdit,
  removeLabel,
  onRemove,
  actionsDisabled = false,
  footer,
  className,
}: ConnectionCardViewProps): ReactElement {
  return (
    <Card
      asChild
      className={cn(
        "min-w-0 gap-4 rounded-kit-card! border border-border bg-surface py-4 text-foreground",
        className,
      )}
    >
      <section aria-label={title}>
        <CardHeader className="flex flex-row items-center gap-3 px-4 pt-0">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-tile",
              iconToneClasses[iconTone],
            )}
          >
            <IconComponent size={18} strokeWidth={1.75} absoluteStrokeWidth />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            <h3 className="m-0 min-w-0 wrap-anywhere text-body leading-5 font-semibold text-foreground">
              {title}
            </h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta leading-4 text-text-secondary">
              <Badge tone={online ? "success" : "neutral"} size="sm" dot>
                {statusLabel}
              </Badge>
              {sources.map((source) => (
                <span
                  key={source.id}
                  className="inline-flex min-w-0 items-center gap-1.5 text-meta text-text-secondary"
                >
                  <span aria-hidden="true" className="text-text-tertiary">
                    ·
                  </span>
                  {source.icon && (
                    <span className="inline-flex size-4 shrink-0 items-center justify-center [&_.source-icon]:size-4 [&_.source-icon>span]:size-4 [&_.source-icon_svg]:size-4">
                      {source.icon}
                    </span>
                  )}
                  <span className="truncate">{source.label}</span>
                </span>
              ))}
            </div>
          </div>
          {(canEdit || removeLabel) && (
            <div className="flex shrink-0 items-center gap-1">
              {canEdit && editLabel && (
                <IconButton
                  icon={Pencil}
                  label={editLabel}
                  compact
                  disabled={actionsDisabled}
                  onClick={onEdit}
                />
              )}
              {removeLabel && (
                <IconButton
                  icon={Trash2}
                  label={removeLabel}
                  compact
                  disabled={actionsDisabled}
                  onClick={onRemove}
                />
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="grid min-w-0 gap-4 px-4 pb-0">
          {address && (
            <CopyField
              value={address}
              label={copyAddressLabel}
              className="w-full"
            />
          )}
          <ConnectionFactsView
            providerLabel={providerLabel}
            providerValue={providerValue}
            methodLabel={methodLabel}
            methodValue={methodValue}
            workerVersion={workerVersion}
          />
          {error && <Alert tone="danger">{error}</Alert>}
          {footer}
        </CardContent>
      </section>
    </Card>
  );
}

export function ConnectionsListView({
  children,
  readError,
  actionError,
  className,
}: {
  children: ReactNode;
  readError?: string;
  actionError?: string;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      {readError && <Alert tone="danger">{readError}</Alert>}
      {children}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
    </div>
  );
}

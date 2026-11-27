import { Pencil, Trash2 } from "lucide-react";
import type { ReactElement, ReactNode, Ref } from "react";
import { Badge } from "../kit/badge";
import { IconButton } from "../kit/button";
import { SensitiveText } from "../kit/privacy";
import { cn } from "../kit/utils";
import { Card, CardContent, CardHeader } from "../ui/card";

export interface ConnectorFactItem {
  label: string;
  value: string;
  renderedValue?: ReactNode;
}

export interface ConnectorCardViewProps {
  title: string;
  statusLabel: string;
  connected?: boolean;
  icon: ReactNode;
  facts: readonly (readonly ConnectorFactItem[])[];
  editing?: boolean;
  editForm?: ReactNode;
  renameLabel?: string;
  removeLabel?: string;
  onRename?: () => void;
  onRemove?: () => void;
  actionsDisabled?: boolean;
  renameButtonRef?: Ref<HTMLButtonElement>;
  className?: string;
}

export function ConnectorCardView({
  title,
  statusLabel,
  connected = false,
  icon,
  facts,
  editing = false,
  editForm,
  renameLabel,
  removeLabel,
  onRename,
  onRemove,
  actionsDisabled = false,
  renameButtonRef,
  className,
}: ConnectorCardViewProps): ReactElement {
  const nonEmptyGroups = facts.filter((group) => group.length > 0);

  return (
    <Card
      asChild
      className={cn(
        "gap-3 rounded-kit-card! border border-border bg-surface py-4 text-foreground",
        className,
      )}
    >
      <section aria-label={title}>
        <CardHeader className="flex flex-row items-center gap-3 px-4 pt-0">
          <span className="flex size-7 shrink-0 items-center justify-center [&_.source-icon]:size-7 [&_.source-icon>span]:size-7 [&_.source-icon_svg]:size-7">
            {icon}
          </span>
          {editing && editForm ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {editForm}
              <Badge
                tone={connected ? "success" : "neutral"}
                size="sm"
                dot
                className="shrink-0"
              >
                {statusLabel}
              </Badge>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <h3 className="m-0 min-w-0 wrap-anywhere text-body leading-5 font-semibold text-foreground">
                {title}
              </h3>
              <Badge
                tone={connected ? "success" : "neutral"}
                size="sm"
                dot
                className="shrink-0"
              >
                {statusLabel}
              </Badge>
            </div>
          )}
          {(renameLabel || removeLabel) && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!editing && renameLabel && (
                <IconButton
                  ref={renameButtonRef}
                  compact
                  icon={Pencil}
                  label={renameLabel}
                  disabled={actionsDisabled}
                  onClick={onRename}
                />
              )}
              {removeLabel && (
                <IconButton
                  compact
                  icon={Trash2}
                  label={removeLabel}
                  disabled={actionsDisabled || editing}
                  onClick={onRemove}
                />
              )}
            </div>
          )}
        </CardHeader>
        {nonEmptyGroups.length > 0 && (
          <CardContent className="px-4 pb-0">
            <dl className="m-0 grid gap-3">
              {nonEmptyGroups.map((group, groupIndex) => (
                <div
                  key={groupIndex}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1.5 text-meta leading-4"
                >
                  {group.map((fact, factIndex) => (
                    <div
                      key={`${fact.label}-${factIndex}`}
                      className="inline-flex min-w-0 max-w-full items-baseline gap-1.5"
                    >
                      {factIndex > 0 && (
                        <span
                          aria-hidden="true"
                          className="mr-0.5 text-text-tertiary"
                        >
                          ·
                        </span>
                      )}
                      <dt className="shrink-0 text-text-secondary">
                        {fact.label}
                      </dt>
                      <dd className="m-0 min-w-0 wrap-anywhere font-medium text-foreground tabular-nums">
                        {fact.renderedValue ?? (
                          <SensitiveText>{fact.value}</SensitiveText>
                        )}
                      </dd>
                    </div>
                  ))}
                </div>
              ))}
            </dl>
          </CardContent>
        )}
      </section>
    </Card>
  );
}

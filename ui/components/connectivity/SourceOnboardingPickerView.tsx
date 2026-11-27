import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Badge } from "../kit/badge";
import { RadioCard, RadioGroup, RadioPrimitive } from "../kit/radio-group";
import { cn } from "../kit/utils";

export interface SourceProductOption {
  value: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  description?: string;
}

export interface SourceProductGroup {
  id: string;
  headingId?: string;
  label: string;
  options: readonly SourceProductOption[];
}

export function SourceProductPickerView({
  groups,
  value,
  onChange,
  className,
}: {
  groups: readonly SourceProductGroup[];
  value: string;
  onChange?: (value: string) => void;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      {groups.map((group) => (
        <section key={group.id} className="grid min-w-0 gap-2">
          <h3
            id={group.headingId}
            tabIndex={group.headingId ? -1 : undefined}
            className="m-0 text-meta leading-4 font-medium text-text-tertiary outline-none"
          >
            {group.label}
          </h3>
          <RadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange?.(next);
            }}
            aria-label={group.label}
            className="min-w-0"
          >
            <div
              data-setup-product-grid=""
              className="grid grid-cols-3 gap-2.5 max-[520px]:grid-cols-2"
            >
              {group.options.map((option) => (
                <div key={option.value} className="flex min-w-0">
                  <RadioPrimitive.Root
                    value={option.value}
                    disabled={option.disabled}
                    aria-label={option.label}
                    title={option.disabled ? option.description : undefined}
                    data-slot="product-radio-tile"
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer flex-col items-start gap-2 rounded-kit-card border border-border bg-surface px-3.5 py-3 text-left text-foreground outline-none hover:not-data-disabled:border-border-strong hover:not-data-disabled:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring data-checked:border-accent data-checked:bg-accent/6 data-disabled:cursor-not-allowed data-disabled:opacity-50",
                      option.value === "custom" && "border-dashed",
                    )}
                  >
                    <div className="flex w-full min-w-0 items-center gap-2.5">
                      <span className="flex size-6 shrink-0 items-center justify-center [&_.source-icon]:size-6 [&_.source-icon>span]:size-6 [&_.source-icon_svg]:size-6">
                        {option.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-small leading-5 font-semibold text-foreground">
                        {option.label}
                      </span>
                    </div>
                    {option.description && (
                      <span className="text-meta leading-4 text-text-secondary">
                        {option.description}
                      </span>
                    )}
                  </RadioPrimitive.Root>
                </div>
              ))}
            </div>
          </RadioGroup>
        </section>
      ))}
    </div>
  );
}

export interface SetupActionCardProps {
  icon: LucideIcon;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function SetupActionCard({
  icon: IconComponent,
  label,
  description,
  badge,
  disabled = false,
  onClick,
  className,
}: SetupActionCardProps): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-kit-card border border-border bg-surface px-4 py-3.5 text-left text-foreground outline-none hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <IconComponent
        size={18}
        strokeWidth={1.75}
        absoluteStrokeWidth
        aria-hidden="true"
        className="shrink-0 text-text-secondary"
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="text-small leading-5 font-semibold text-foreground">
          {label}
        </strong>
        {description && (
          <small className="text-meta leading-4 text-text-secondary">
            {description}
          </small>
        )}
      </span>
      {badge && (
        <Badge tone="accent" size="sm" className="shrink-0">
          {badge}
        </Badge>
      )}
    </button>
  );
}

export interface SourceConnectionOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function SourceConnectionStepView({
  prompt,
  connectionsLabel,
  connections,
  selectedConnection,
  onSelectConnection,
  disabled = false,
  hasSelectableConnection,
  emptyTitle,
  emptyPrompt,
  emptyActions,
  addConnectionAction,
  className,
}: {
  prompt?: string;
  connectionsLabel: string;
  connections: readonly SourceConnectionOption[];
  selectedConnection: string;
  onSelectConnection?: (value: string) => void;
  disabled?: boolean;
  hasSelectableConnection: boolean;
  emptyTitle: string;
  emptyPrompt: string;
  emptyActions: ReactNode;
  addConnectionAction?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={cn("grid min-w-0 gap-4", className)}>
      {hasSelectableConnection && prompt && (
        <p className="m-0 text-small leading-5 text-text-secondary">{prompt}</p>
      )}
      {connections.length > 0 && (
        <RadioGroup
          aria-label={connectionsLabel}
          value={selectedConnection}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string") onSelectConnection?.(next);
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
      )}
      {!hasSelectableConnection && (
        <div className="grid min-w-0 gap-2.5">
          <h3 className="m-0 text-body leading-5 font-semibold text-foreground">
            {emptyTitle}
          </h3>
          <p className="m-0 text-small leading-5 text-text-secondary">
            {emptyPrompt}
          </p>
          <div className="mt-1.5">{emptyActions}</div>
        </div>
      )}
      {hasSelectableConnection && addConnectionAction}
    </div>
  );
}

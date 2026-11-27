import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type * as React from "react";
import { cn, stateClass } from "./utils";

export function RadioGroup({
  className,
  ...props
}: RadioGroupPrimitive.Props): React.ReactElement {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={stateClass("flex flex-col gap-2.5", className)}
      {...props}
    />
  );
}

export function Radio({
  className,
  ...props
}: RadioPrimitive.Root.Props): React.ReactElement {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={stateClass(
        "relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-strong bg-card not-dark:bg-clip-padding outline-none transition-[border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-indicator"
        className="flex size-full items-center justify-center rounded-full bg-primary before:size-1.5 before:rounded-full before:bg-primary-foreground data-unchecked:hidden"
      />
    </RadioPrimitive.Root>
  );
}

export interface RadioCardProps extends Omit<RadioPrimitive.Root.Props, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  graphic?: React.ReactNode;
  badge?: React.ReactNode;
}

export function RadioCard({
  title,
  description,
  graphic,
  badge,
  className,
  ...props
}: RadioCardProps): React.ReactElement {
  return (
    <RadioPrimitive.Root
      data-slot="radio-card"
      className={stateClass(
        "group relative flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-[var(--radius-kit-card,10px)] border border-border bg-surface p-3 text-left text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-data-disabled:border-border-strong focus-visible:ring-2 focus-visible:ring-ring data-checked:border-accent data-checked:bg-accent/6 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {graphic && (
        <span className="flex shrink-0 items-center justify-center">
          {graphic}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-small font-semibold text-foreground">
          <span className="truncate">{title}</span>
          {badge}
        </span>
        {description && (
          <span className="text-meta leading-4 text-text-secondary">
            {description}
          </span>
        )}
      </span>
      <RadioPrimitive.Indicator
        keepMounted
        data-slot="radio-card-indicator"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong transition-colors duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none data-checked:border-accent data-checked:bg-accent before:size-1.5 before:rounded-full before:bg-on-accent data-unchecked:before:hidden"
      />
    </RadioPrimitive.Root>
  );
}

export interface RadioSwatchProps extends RadioPrimitive.Root.Props {
  swatch: string;
  label: string;
}

export function RadioSwatch({
  swatch,
  label,
  className,
  ...props
}: RadioSwatchProps): React.ReactElement {
  return (
    <RadioPrimitive.Root
      aria-label={label}
      data-slot="radio-swatch"
      className={stateClass(
        "inline-flex h-7 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-badge,5px)] outline-none transition-[background-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-surface-raised data-checked:shadow-sm data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("size-4 rounded-full")}
        style={{ background: swatch }}
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroupPrimitive, RadioPrimitive, Radio as RadioGroupItem };

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Spinner } from "./spinner";
import { cn } from "./utils";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-kit-field border border-transparent font-semibold text-small outline-none transition-[color,background-color,border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 data-loading:select-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "secondary",
    },
    variants: {
      size: {
        default: "h-(--kit-control-height) px-3",
        sm: "h-(--kit-control-height-sm) px-2.5 text-meta [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 gap-1 rounded-badge px-2 text-meta [&_svg:not([class*='size-'])]:size-3",
        icon: "size-(--kit-control-height) p-0",
        "icon-sm":
          "size-(--kit-control-height-sm) p-0 [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 data-pressed:bg-primary/85",
        secondary:
          "bg-surface-subtle text-foreground hover:bg-surface-sunken data-pressed:bg-surface-sunken",
        outline:
          "border-border-strong bg-surface text-foreground hover:bg-surface-subtle data-pressed:bg-surface-sunken",
        ghost:
          "bg-transparent text-text-secondary hover:bg-surface-subtle hover:text-foreground data-pressed:bg-surface-sunken",
        link: "h-auto border-transparent bg-transparent px-0 font-semibold text-accent-text hover:underline underline-offset-3",
        danger:
          "bg-destructive/14 text-destructive hover:bg-destructive/20 data-pressed:bg-destructive/24",
        "danger-outline":
          "border-destructive bg-transparent text-destructive hover:bg-destructive/10 data-pressed:bg-destructive/14",
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
  busy?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  busy = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isBusy = Boolean(loading || busy);
  const isDisabled = Boolean(isBusy || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";

  const defaultProps = {
    children: (
      <>
        {isBusy && <Spinner size={14} data-slot="button-loading-indicator" />}
        {children}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-busy": isBusy || undefined,
    "aria-disabled": isBusy || undefined,
    "data-loading": isBusy ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export interface IconButtonProps
  extends Omit<ButtonProps, "children" | "aria-label"> {
  icon: LucideIcon;
  label: string;
  iconSize?: number;
  compact?: boolean;
  filled?: boolean;
}

export function IconButton({
  icon: IconComponent,
  label,
  iconSize = 16,
  compact = false,
  filled = false,
  busy = false,
  loading = false,
  variant,
  size,
  className,
  ...props
}: IconButtonProps): React.ReactElement {
  const isBusy = Boolean(loading || busy);
  const resolvedVariant = variant ?? (filled ? "secondary" : "ghost");
  const resolvedSize = size ?? (compact ? "icon-sm" : "icon");

  return (
    <Button
      aria-label={label}
      variant={resolvedVariant}
      size={resolvedSize}
      disabled={props.disabled || isBusy}
      aria-busy={isBusy || undefined}
      data-slot="icon-button"
      className={cn("rounded-pill", className)}
      {...props}
    >
      {isBusy ? (
        <Spinner size={iconSize} />
      ) : (
        <IconComponent
          size={iconSize}
          strokeWidth={1.75}
          absoluteStrokeWidth
          aria-hidden="true"
        />
      )}
    </Button>
  );
}

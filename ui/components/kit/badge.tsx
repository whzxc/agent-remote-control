import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils";

export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--radius-badge,5px)] border border-transparent font-medium outline-none [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      tone: "neutral",
    },
    variants: {
      size: {
        sm: "h-5 px-2 text-caption",
        default: "h-6 px-2.5 text-meta",
        lg: "h-7 px-3 text-small",
      },
      tone: {
        neutral: "bg-secondary text-text-secondary",
        accent: "bg-accent/14 text-accent-text",
        success: "bg-success/14 text-success",
        warning: "bg-warning/14 text-warning",
        danger: "bg-danger/14 text-danger",
        command: "bg-phase-command/14 text-phase-command",
      },
    },
  },
);

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  tone?: VariantProps<typeof badgeVariants>["tone"];
  size?: VariantProps<typeof badgeVariants>["size"];
  dot?: boolean;
}

export function Badge({
  className,
  tone,
  size,
  dot = false,
  render,
  children,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    children: (
      <>
        {dot && (
          <span
            aria-hidden="true"
            data-slot="badge-dot"
            className="size-1.5 shrink-0 rounded-full bg-current"
          />
        )}
        {children}
      </>
    ),
    className: cn(badgeVariants({ className, size, tone })),
    "data-slot": "badge",
    "data-tone": tone ?? "neutral",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

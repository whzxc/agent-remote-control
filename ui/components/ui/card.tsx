import * as React from "react"
import { Slot } from "radix-ui"
import { cn } from "../../lib/utils"

function Card({ className, asChild = false, padded = false, variant = "default", ...props }: React.ComponentProps<"div"> & { asChild?: boolean; padded?: boolean; variant?: "default" | "reply" }) {
  const Component = asChild ? Slot.Root : "div";
  return (
    <Component
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-[var(--radius-card)] text-[var(--text)]",
        padded ? "p-4" : "py-4",
        variant === "reply" ? "bg-[var(--surface)]" : "bg-[var(--surface-subtle)]",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-4 [.border-b]:pb-4",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardContent,
}

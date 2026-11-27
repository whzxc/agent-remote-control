import * as React from "react";
import * as Kit from "../kit/card";
import { cn } from "../kit/utils";

function Card({ className, asChild = false, padded = false, variant = "default", ...props }: React.ComponentProps<"div"> & { asChild?: boolean; padded?: boolean; variant?: "default" | "reply" }) {
  const { children, ...rest } = props;
  const cardClass = cn(
    "gap-4 rounded-card border-0 text-foreground",
    padded ? "p-4" : "py-4",
    variant === "reply" ? "bg-surface" : "bg-surface-subtle",
    className,
  );
  if (asChild && React.isValidElement(children)) {
    return (
      <Kit.Card
        {...rest}
        className={cardClass}
        render={children as React.ReactElement<Record<string, unknown>>}
      />
    );
  }
  return (
    <Kit.Card {...rest} className={cardClass}>
      {children}
    </Kit.Card>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Kit.CardHeader
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-4 pt-0 [.border-b]:pb-4",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <Kit.CardContent className={cn("px-4", className)} {...props} />;
}

export { Card, CardHeader, CardContent };

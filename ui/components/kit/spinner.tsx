import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { cn } from "./utils";

export function Spinner({
  className,
  size = 16,
  ...props
}: Omit<ComponentProps<typeof LoaderCircle>, "size"> & {
  size?: number;
}): ReactElement {
  return (
    <LoaderCircle
      data-slot="spinner"
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth
      aria-hidden="true"
      className={cn("shrink-0 animate-spin motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export function Loading({
  label,
  className,
}: {
  label?: string;
  className?: string;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div
      data-slot="loading"
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 p-6 text-body text-text-secondary",
        className,
      )}
    >
      <Spinner size={16} />
      <span>{label ?? t("loading")}</span>
    </div>
  );
}

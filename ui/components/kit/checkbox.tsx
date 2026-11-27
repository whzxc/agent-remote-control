import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { useId, type ReactElement, type ReactNode } from "react";
import { cn, stateClass } from "./utils";

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props): ReactElement {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={stateClass(
        "relative inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-disclosure border border-border-strong bg-card not-dark:bg-clip-padding outline-none transition-[background-color,border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-primary-foreground data-unchecked:hidden"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? (
              <Minus size={12} strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <Check size={12} strokeWidth={2.5} aria-hidden="true" />
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export function CheckboxField({
  children,
  className,
  id: idProp,
  ...props
}: CheckboxPrimitive.Root.Props & {
  children: ReactNode;
}): ReactElement {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  return (
    <label
      htmlFor={id}
      data-slot="checkbox-field"
      className={cn(
        "flex min-h-7 min-w-0 cursor-pointer items-start gap-2 py-1 text-small text-foreground",
        props.disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <Checkbox id={id} className="mt-0.5" {...props} />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </label>
  );
}

export { CheckboxPrimitive };

import { Input as InputPrimitive } from "@base-ui/react/input";
import { Search } from "lucide-react";
import type * as React from "react";
import { cn } from "./utils";

const inputSizes = {
  default: { height: "h-(--kit-field-height)", text: "px-3 text-body" },
  sm: { height: "h-(--kit-control-height-sm)", text: "px-2.5 text-small" },
  lg: { height: "h-10", text: "px-3.5 text-body" },
};

export interface InputProps
  extends Omit<React.ComponentProps<"input">, "size"> {
  size?: keyof typeof inputSizes;
  unstyled?: boolean;
  inputClassName?: string;
}

const numberInputReset =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none";

export function Input({
  className,
  inputClassName,
  size = "default",
  type,
  unstyled = false,
  ...props
}: InputProps): React.ReactElement {
  const numberReset = type === "number" ? numberInputReset : undefined;
  if (unstyled) {
    return (
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "w-full min-w-0 border-0 bg-transparent text-foreground placeholder:text-text-tertiary outline-none disabled:pointer-events-none disabled:cursor-not-allowed",
          inputSizes[size].height,
          inputSizes[size].text,
          numberReset,
          className,
          inputClassName,
        )}
        {...props}
      />
    );
  }

  return (
    <span
      data-slot="input-control"
      className={cn(
        "relative inline-flex w-full min-w-0 rounded-kit-field border border-border bg-surface not-dark:bg-clip-padding ring-ring/24 transition-[border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:border-border-strong has-focus-visible:border-ring has-focus-visible:ring-2 has-aria-invalid:border-destructive has-aria-invalid:bg-destructive/8 has-aria-invalid:ring-destructive/20 has-disabled:opacity-50",
        inputSizes[size].height,
        className,
      )}
    >
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "h-full w-full min-w-0 rounded-[inherit] border-0 bg-transparent text-foreground placeholder:text-text-tertiary outline-none file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-small file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed",
          inputSizes[size].text,
          numberReset,
          inputClassName,
        )}
        {...props}
      />
    </span>
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full min-w-0 rounded-kit-field border border-border bg-surface px-3 py-2 text-body text-foreground placeholder:text-text-tertiary outline-none ring-ring/24 transition-[border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-disabled:not-focus-visible:not-aria-invalid:border-border-strong focus-visible:border-ring focus-visible:ring-2 aria-invalid:border-destructive aria-invalid:bg-destructive/8 aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export interface SearchInputProps
  extends Omit<React.ComponentProps<"input">, "size" | "type"> {
  placeholder: string;
  inputClassName?: string;
}

export function SearchInput({
  className,
  inputClassName,
  placeholder,
  "aria-label": ariaLabel,
  ...props
}: SearchInputProps): React.ReactElement {
  return (
    <label
      data-slot="search-input"
      className={cn(
        "relative inline-flex h-(--kit-control-height) w-full min-w-0 items-center rounded-kit-field border border-border bg-surface not-dark:bg-clip-padding ring-ring/24 transition-[border-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:not-has-disabled:not-has-focus-visible:border-border-strong has-focus-visible:border-ring has-focus-visible:ring-2 has-disabled:opacity-50",
        className,
      )}
    >
      <Search
        size={14}
        strokeWidth={1.75}
        absoluteStrokeWidth
        aria-hidden="true"
        className="pointer-events-none absolute left-3 shrink-0 text-text-tertiary"
      />
      <InputPrimitive
        type="search"
        data-slot="input"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn(
          "h-full w-full min-w-0 rounded-[inherit] border-0 bg-transparent pl-8 pr-3.5 text-small text-foreground placeholder:text-text-tertiary outline-none [&::-webkit-search-cancel-button]:hidden disabled:pointer-events-none disabled:cursor-not-allowed",
          inputClassName,
        )}
        {...props}
      />
    </label>
  );
}

export { InputPrimitive };

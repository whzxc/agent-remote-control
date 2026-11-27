import type { ReactNode } from "react";
import { Frame } from "adg";
import { Field as KitField, Input as KitInput } from "@/components/kit";
import { fieldForms } from "../fixtures/inputs";

export function Input({
  value,
  placeholder,
  invalid = false,
  truncate = false,
  className: extra = "",
}: {
  value?: string;
  placeholder?: string;
  invalid?: boolean;
  truncate?: boolean;
  className?: string;
}) {
  return (
    <KitInput
      defaultValue={value}
      placeholder={placeholder}
      readOnly
      aria-invalid={invalid || undefined}
      className={extra}
      inputClassName={truncate ? "truncate" : undefined}
    />
  );
}

export function Field({
  id,
  label,
  error,
  help,
  children,
  compact = false,
}: {
  id?: string;
  label: ReactNode;
  error?: string;
  help?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <KitField
      id={id}
      label={label}
      error={error}
      help={help}
      compact={compact}
    >
      {children}
    </KitField>
  );
}

export default () => [
  ...fieldForms.map(({ name, value, ...props }) => (
    <Frame key={`field-${name}`} name={name === "default" ? "field" : `field-${name}`} width={280}>
      <Field {...props}>
        <Input value={value} invalid={!!props.error} />
      </Field>
    </Frame>
  )),
  ...fieldForms.map(({ name, value, error }) => (
    <Frame key={`input-${name}`} name={name === "default" ? "input" : `input-${name}`} width={280}>
      <Input value={value} invalid={!!error} className="w-full" />
    </Frame>
  )),
];

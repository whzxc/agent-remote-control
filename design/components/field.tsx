import { Frame, Icon } from "adg";
import { fieldForms } from "../fixtures/inputs";

export function Input({
  value,
  placeholder,
  invalid = false,
  class: extra = "",
}: {
  value?: string;
  placeholder?: string;
  invalid?: boolean;
  class?: string;
}) {
  const paint = invalid
    ? `relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]
      before:bg-danger before:opacity-10 outline outline-danger -outline-offset-1`
    : "bg-surface-sunken";
  return (
    <div
      class={`flex items-center h-(--field-height) px-(--field-padding-inline)
        rounded-field text-body leading-5 text-text ${paint} ${extra}`}
    >
      {value || <span class="text-text-tertiary">{placeholder}</span>}
    </div>
  );
}
export function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id?: string;
  label: unknown;
  error?: string;
  help?: unknown;
  children?: unknown;
}) {
  return (
    <div class="flex w-full min-w-0 flex-col gap-2 text-text">
      <div class="flex items-center justify-between gap-2 text-small leading-4 font-semibold">
        <label for={id}>{label}</label>
        {help}
      </div>
      {children}
      {error && (
        <div class="flex items-center gap-(--field-error-gap) text-meta leading-3 text-danger">
          <Icon name="circle-alert" size={14} class="size-(--field-icon-size)" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
export default () => [
  ...fieldForms.map(({ name, value, ...props }) => (
    <Frame name={name === "default" ? "field" : `field-${name}`} width={280}>
      <Field {...props}>
        <Input value={value} invalid={!!props.error} />
      </Field>
    </Frame>
  )),
  ...fieldForms.map(({ name, value, error }) => (
    <Frame name={name === "default" ? "input" : `input-${name}`} width={280}>
      <Input value={value} invalid={!!error} class="w-full" />
    </Frame>
  )),
];

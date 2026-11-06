import { Frame, Icon } from "sdg";
const forms = [
  { name: "default", label: "服务器名称", value: "docs" },
  {
    name: "error",
    label: "地址",
    value: "tools.example",
    error: "需要完整的 HTTPS 地址",
  },
];
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
  return (
    <div
      class={`flex items-center h-(--field-height) px-[14px] rounded-field text-body leading-5 text-text ${invalid ? "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-danger before:opacity-10 outline outline-danger -outline-offset-1" : "bg-surface-sunken"} ${extra}`}
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
        <div class="flex items-center gap-[5px] text-meta leading-3 text-danger">
          <Icon name="circle-alert" size={14} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
export default () =>
  forms.map(({ name, value, ...props }) => (
    <Frame name={name} width={280}>
      <Field {...props}>
        <Input value={value} invalid={!!props.error} />
      </Field>
    </Frame>
  ));

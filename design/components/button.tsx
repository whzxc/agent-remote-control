import { Frame, Icon } from "sdg";
import { buttonForms } from "../fixtures/buttons";

export type ButtonProps = {
  variant?:
    "primary" | "secondary" | "ghost" | "link" | "danger" | "danger-outline";
  busy?: boolean;
  disabled?: boolean;
  icon?: string;
  children?: unknown;
  class?: string;
};
export function Button({
  variant = "secondary",
  busy,
  disabled,
  icon,
  children,
  class: extra = "",
}: ButtonProps) {
  const paint = {
    primary: "bg-action text-on-action",
    secondary: "bg-surface-sunken text-text",
    ghost: "text-text",
    link: "text-accent-text",
    danger:
      `relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit]
      before:bg-danger before:opacity-14 text-danger`,
    "danger-outline": "text-danger border border-danger",
  };
  return (
    <button
      disabled={disabled || busy}
      aria-busy={busy}
      class={`inline-flex shrink-0 items-center justify-center gap-(--control-gap)
        ${variant === "link" ? "h-6 px-0" : "h-(--control-height) px-4"}
        rounded-control text-small leading-4 font-semibold whitespace-nowrap ${paint[variant]} ${extra}`}
    >
      {(busy || icon) && (
        <Icon name={busy ? "loader-circle" : icon!} class="size-(--control-icon-size)" />
      )}
      {children}
    </button>
  );
}
export default () =>
  buttonForms.map(({ name, text, ...props }) => (
    <Frame name={name}>
      <Button {...props}>{text}</Button>
    </Frame>
  ));

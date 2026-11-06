import { Frame, Icon } from "sdg";
const forms = [
  { name: "primary", variant: "primary", icon: "plus", text: "添加服务器" },
  {
    name: "secondary",
    variant: "secondary",
    icon: "rotate-cw",
    text: "重新连接",
  },
  { name: "ghost", variant: "ghost", text: "取消" },
  { name: "danger", variant: "danger", text: "删除" },
  { name: "pending", variant: "primary", busy: true, text: "正在安装" },
] as const;
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
      "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-danger before:opacity-14 text-danger",
    "danger-outline": "text-danger border border-danger",
  };
  return (
    <button
      disabled={disabled || busy}
      aria-busy={busy}
      class={`inline-flex shrink-0 items-center justify-center gap-[6px] h-(--control-height) px-4 rounded-control text-small leading-4 font-semibold whitespace-nowrap ${paint[variant]} ${extra}`}
    >
      {(busy || icon) && (
        <Icon name={busy ? "loader-circle" : icon!} size={16} />
      )}
      {children}
    </button>
  );
}
export default () =>
  forms.map(({ name, text, ...props }) => (
    <Frame name={name}>
      <Button {...props}>{text}</Button>
    </Frame>
  ));

import { Frame, Icon } from "adg";
import { forms } from "../fixtures/tags";

export function Tag({
  children,
  form = "spec",
  icon,
}: {
  children?: unknown;
  form?: "spec" | "meta" | "fact" | "danger" | "ownership";
  icon?: string;
}) {
  const small = form === "meta" || form === "spec" || form === "danger";
  return (
    <span
      class={
        "inline-flex items-center gap-2 rounded-field whitespace-nowrap " +
        String(
          small
            ? "h-5 px-[8px] text-caption"
            : `h-6 pl-[10px] ${form === "ownership" ? "pr-5" : "pr-[10px]"} text-meta`,
        ) +
        " " +
        String(
          form === "danger"
            ? "relative isolate before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] " +
                "before:bg-danger before:opacity-14 text-danger"
            : form === "fact"
              ? "bg-surface text-text-secondary"
              : "bg-surface-sunken text-text-secondary",
        )
      }
    >
      {(icon || form === "ownership") && <Icon name={icon || "app-window"} size={14} />}
      {children}
    </span>
  );
}
export function Disclosure({ expanded = false, children }: { expanded?: boolean; children?: unknown }) {
  return (
    <span class="inline-flex items-center gap-[3px] h-6 px-[10px] rounded-field bg-surface text-text text-meta font-semibold">
      {children}
      <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} class="text-text-secondary" />
    </span>
  );
}
export default () =>
  forms.map(({ name, text }) => (
    <Frame name={name === "disclosure" ? name : `tag-${name}`}>
      {name === "disclosure" ? <Disclosure>{text}</Disclosure> : <Tag form={name}>{text}</Tag>}
    </Frame>
  ));

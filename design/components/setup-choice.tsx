import { Frame, Icon } from "sdg";
import { BrandMark, type Brand } from "./agent-icon";
const forms = [
  {
    name: "row",
    label: "创建我的中继",
    description: "推荐 · 部署到你的 Cloudflare 免费账号",
  },
  { name: "product", label: "Claude Code", description: "仅本机客户端可用" },
] as const;
export function SetupChoice({
  label,
  description,
  selected = false,
  form = "row",
  brand,
  icon,
  badge,
  catalog = false,
  graphic,
  disabled = false,
}: {
  label: string;
  description?: string;
  selected?: boolean;
  form?: "row" | "product";
  brand?: Brand;
  icon?: string;
  badge?: string;
  catalog?: boolean;
  graphic?: unknown;
  disabled?: boolean;
}) {
  return form === "product" ? (
    <div
      class={`flex w-full flex-col ${disabled ? "opacity-45" : ""} gap-[10px] rounded-card bg-surface-subtle px-[14px] pt-4 ${catalog && !description ? "pb-4" : "pb-[10px]"}`}
    >
      <div class="flex items-center gap-[10px]">
        {graphic || <BrandMark brand={brand} size={24} />}
        <strong class="text-small text-text leading-4">{label}</strong>
      </div>
      {description && (
        <p class="text-meta leading-4 text-text-secondary">{description}</p>
      )}
    </div>
  ) : (
    <div
      class={`flex w-full items-center gap-[13px] rounded-card bg-surface-subtle px-[15px] ${catalog && !description ? "py-[19px]" : "py-4"}`}
    >
      {icon ? (
        <Icon name={icon} size={18} class="text-text" />
      ) : (
        <span class="grid size-[18px] shrink-0 place-items-center rounded-[9px] bg-surface-sunken">
          {selected && <span class="size-2 rounded-[4px] bg-accent-text" />}
        </span>
      )}
      <div class="flex flex-1 flex-col gap-2">
        <strong class="text-body leading-4 text-text font-[650]">
          {label}
        </strong>
        {description && (
          <p class="text-small leading-4 text-text-secondary">{description}</p>
        )}
      </div>
      {badge && (
        <span
          class={`text-meta ${catalog ? "text-accent-text" : "text-text-secondary"}`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
export function SetupAction(props: {
  icon: string;
  label: string;
  description?: string;
  badge?: string;
  catalog?: boolean;
}) {
  return <SetupChoice {...props} />;
}
export default () =>
  forms.map(({ name, ...props }) => (
    <Frame name={name} width={name === "row" ? 680 : 204}>
      <SetupChoice {...props} form={name} selected brand="claude-code" />
    </Frame>
  ));

import type { ReactNode } from "react";
import { Frame, Icon } from "adg";
import { BrandMark, type Brand } from "./brand-mark";
import { setupChoiceForms } from "../fixtures/choices";

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
  graphic?: ReactNode;
  disabled?: boolean;
}) {
  return form === "product" ? (
    <div
      className={`flex w-full flex-col ${disabled ? "opacity-45" : ""} gap-[10px]
        rounded-card bg-surface-subtle px-[14px] pt-4 ${catalog && !description ? "pb-4" : "pb-[10px]"}`}
    >
      <div className="flex items-center gap-[10px]">
        {graphic || <BrandMark brand={brand} size={24} />}
        <strong className="text-small text-text leading-4">{label}</strong>
      </div>
      {description && (
        <p className="text-meta leading-4 text-text-secondary">{description}</p>
      )}
    </div>
  ) : (
    <div
      className={`flex w-full items-center gap-[13px] rounded-card bg-surface-subtle px-[15px]
        ${catalog && !description ? "py-[19px]" : "py-4"}`}
    >
      {icon ? (
        <Icon name={icon} size={18} className="text-text" />
      ) : (
        <span className="grid size-[18px] shrink-0 place-items-center rounded-[9px] bg-surface-sunken">
          {selected && <span className="size-2 rounded-[4px] bg-accent-text" />}
        </span>
      )}
      <div className="flex flex-1 flex-col gap-2">
        <strong className="text-body leading-4 text-text font-[650]">
          {label}
        </strong>
        {description && (
          <p className="text-small leading-4 text-text-secondary">{description}</p>
        )}
      </div>
      {badge && (
        <span
          className={`text-meta ${catalog ? "text-accent-text" : "text-text-secondary"}`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
export default () =>
  setupChoiceForms.map(({ form, ...props }) => (
    <Frame name={form} width={form === "row" ? 680 : 204}>
      <SetupChoice {...props} form={form} />
    </Frame>
  ));

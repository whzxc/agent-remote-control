import { Frame, Icon } from "sdg";
import { BrandMark, type Brand } from "./agent-icon";
import { SetupChoice } from "./setup-choice";
const themeOptions = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
];
const platforms = [
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["xai", "xAI"],
  ["microsoft", "Microsoft"],
  ["notion", "Notion"],
  ["slack", "Slack"],
  ["raycast", "Raycast"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["alibaba", "Alibaba"],
  ["other", "Other"],
];
const navigationOptions = platforms.map(([value, label]) => ({
  value,
  label,
  graphic:
    value === "other" ? (
      <Icon name="plug" size={22} />
    ) : (
      <BrandMark brand={value as Brand} size={22} />
    ),
}));
const tabsOptions = [
  { value: "current", label: "Current" },
  { value: "activity", label: "Activity" },
];
const cardOptions = [{ value: "alpha", label: "Alpha" }];
export type Choice = {
  value: string;
  label: string;
  icon?: string;
  graphic?: unknown;
  description?: string;
  disabled?: boolean;
  brand?: Brand;
};
export type SingleChoiceProps = {
  value: string;
  options: readonly Choice[];
  label: string;
  disabled?: boolean;
  fill?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  cards?: boolean;
  optionCards?: boolean;
  dropdown?: boolean;
  navigation?: boolean;
  tabs?: boolean;
  tiles?: boolean;
  form?: "setup-row" | "setup-product";
  class?: string;
  catalog?: boolean;
};
export function SingleChoice({
  value,
  options,
  label,
  disabled,
  dropdown,
  navigation,
  tabs,
  optionCards,
  cards,
  tiles,
  form,
  fill,
  iconOnly,
  compact,
  class: extra = "",
  catalog = false,
}: SingleChoiceProps) {
  if (cards || tiles || form)
    return (
      <div
        role="radiogroup"
        aria-label={label}
        class={`grid ${catalog ? "gap-[10px]" : "gap-3"} ${extra} ${tiles || form === "setup-product" ? "grid-cols-3" : "grid-cols-1"}`}
      >
        {options.map((option) => (
          <SetupChoice
            {...option}
            catalog={catalog}
            selected={option.value === value}
            form={tiles || form === "setup-product" ? "product" : "row"}
          />
        ))}
      </div>
    );
  if (dropdown || (!navigation && !tabs && !optionCards && options.length > 5))
    return (
      <button
        aria-label={label}
        disabled={disabled}
        class={`inline-flex h-(--control-height) items-center gap-[6px] px-4 rounded-control bg-surface-sunken text-text text-small whitespace-nowrap ${fill ? "w-full justify-between" : ""} ${extra}`}
      >
        <span>{options.find((option) => option.value === value)?.label}</span>
        <Icon name="chevron-down" size={14} class="text-text-secondary" />
      </button>
    );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      class={`${extra} ${
        navigation
          ? "flex w-full flex-col gap-1 rounded-card bg-surface-sunken px-2 pt-3 pb-4"
          : optionCards
            ? "flex w-full flex-col gap-2"
            : tabs
              ? "inline-flex gap-[3px]"
              : `inline-grid grid-flow-col auto-cols-fr rounded-control bg-surface-sunken p-[3px] ${fill ? "w-full" : ""}`
      }`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const content = (
          <>
            {option.graphic ||
              (option.icon && (
                <Icon name={option.icon} size={navigation ? 22 : 16} />
              ))}
            {!iconOnly && <span>{option.label}</span>}
          </>
        );
        return (
          <button
            role="radio"
            aria-checked={selected}
            disabled={disabled || option.disabled}
            class={`flex items-center ${navigation ? "gap-3 h-10 px-3 rounded-[14px] text-body" : optionCards ? "gap-5 h-11 px-4 rounded-card text-body font-medium bg-surface-sunken" : tabs ? "h-(--control-height) px-3 text-body" : `h-7 ${compact ? "px-0" : "px-4"} rounded-[14px] justify-center text-small whitespace-nowrap`} ${selected ? `text-text ${!optionCards ? "font-[650]" : ""} ${!tabs && !optionCards ? "bg-surface-raised shadow-sm" : ""}` : "text-text-secondary"}`}
          >
            {optionCards && (
              <span class="font-mono text-meta text-text-tertiary">
                {index + 1}
              </span>
            )}
            {tabs ? (
              <span
                class={`flex h-full items-center border-b-2 ${selected ? "border-accent-text" : "border-transparent"}`}
              >
                {content}
              </span>
            ) : (
              content
            )}
          </button>
        );
      })}
    </div>
  );
}
export default () => [
  <Frame name="pills">
    <SingleChoice value="system" options={themeOptions} label="Theme" />
  </Frame>,
  <Frame name="dropdown">
    <SingleChoice
      value="system"
      options={themeOptions}
      label="Theme"
      dropdown
    />
  </Frame>,
  <Frame name="navigation" width={216}>
    <SingleChoice
      value="openai"
      options={navigationOptions}
      label="Platform"
      navigation
    />
  </Frame>,
  <Frame name="tabs">
    <SingleChoice value="current" options={tabsOptions} label="Board" tabs />
  </Frame>,
  <Frame name="option-card" width={394}>
    <SingleChoice
      value="alpha"
      options={cardOptions}
      label="Option"
      optionCards
    />
  </Frame>,
];

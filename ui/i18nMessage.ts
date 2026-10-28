export type Locale = "en" | "zh-CN";

const pluralRules = {
  en: new Intl.PluralRules("en"),
  "zh-CN": new Intl.PluralRules("zh-CN"),
};

/** A category suffix overrides the base message only for a finite numeric count. */
export function formatMessage(
  locale: Locale,
  messages: Readonly<Record<string, string>>,
  key: string,
  params: Record<string, unknown> = {},
): string | undefined {
  const { count } = params;
  const variant = typeof count === "number" && Number.isFinite(count)
    ? messages[`${key}.${pluralRules[locale].select(count)}`]
    : undefined;
  const message = variant ?? messages[key];
  return message?.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

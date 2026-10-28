import { appEnvironment, envOverrides } from "./state/appEnvironment";
import { createStore, preference } from "./state/store";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import { formatMessage, type Locale } from "./i18nMessage";
export type { Locale } from "./i18nMessage";
export type MessageKey = keyof typeof en;
export type LanguagePreference = "auto" | Locale;
export const languageOptions = [
  { value: "auto", label: "Auto" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];
const normalize = (value: unknown): LanguagePreference =>
  value === "en" || value === "zh-CN" ? value : "auto";
export const language = preference<LanguagePreference>(
  "language",
  "auto",
  normalize,
  (value) => value,
);
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase().replaceAll("_", "-");
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "zh" || /^zh-(cn|sg|hans)(-|$)/.test(tag)) return "zh-CN";
  }
  return "en";
}
export const locale = createStore<Locale>("en");
export function t(key: string, params: Record<string, unknown> = {}): string {
  const selected = locale.get();
  return formatMessage(selected, selected === "zh-CN" ? zhCN : en, key, params)
    ?? formatMessage("en", en, key, params) ?? key;
}
export function setLanguage(value: string) {
  language.set(normalize(value));
}
function updateLocale() {
  const selected = language.get();
  const resolvedLocale = selected === "auto" ? resolveLocale(navigator.languages) : selected;
  const next = envOverrides().locale ?? resolvedLocale;
  locale.set(next);
  document.documentElement.lang = next;
  if ("__TAURI_INTERNALS__" in window)
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_ui_locale", { locale: next, resolvedLocale }))
      .catch(console.error);
}
appEnvironment.subscribe(updateLocale);
language.subscribe(updateLocale);
window.addEventListener("languagechange", updateLocale);
updateLocale();

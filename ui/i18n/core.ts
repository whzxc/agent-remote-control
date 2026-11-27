import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";
import { formatMessage, type Locale } from "../i18nMessage";

export { formatMessage, type Locale } from "../i18nMessage";
export type MessageKey = keyof typeof en;
export type LanguagePreference = "auto" | Locale;

export const languageOptions = [
  { value: "auto", label: "Auto" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
] as const;

export function normalizeLanguage(value: unknown): LanguagePreference {
  return value === "en" || value === "zh-CN" ? value : "auto";
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const item of languages) {
    const tag = item.toLowerCase().replaceAll("_", "-");
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "zh" || /^zh-(cn|sg|hans)(-|$)/.test(tag)) return "zh-CN";
  }
  return "en";
}

export function translate(
  selected: Locale,
  key: string,
  params: Record<string, unknown> = {},
): string {
  return (
    formatMessage(selected, selected === "zh-CN" ? zhCN : en, key, params) ??
    formatMessage("en", en, key, params) ??
    key
  );
}

let activeLocale: Locale = "en";
let ssrLocale: Locale | null = null;
let runtimeReader: (() => Locale) | null = null;
const listeners = new Set<() => void>();

export function notifyLocaleListeners() {
  listeners.forEach((listener) => listener());
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setRuntimeLocaleReader(reader: (() => Locale) | null) {
  runtimeReader = reader;
}

export function setSsrLocale(next: Locale | null) {
  ssrLocale = next;
  if (next !== null) activeLocale = next;
  notifyLocaleListeners();
}

export function getActiveLocale(): Locale {
  if (ssrLocale !== null) return ssrLocale;
  return runtimeReader ? runtimeReader() : activeLocale;
}

export function t(key: string, params: Record<string, unknown> = {}): string {
  return translate(getActiveLocale(), key, params);
}

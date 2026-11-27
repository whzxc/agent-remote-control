import { isDesktop } from "../nativeBridge";
import { appEnvironment, envOverrides } from "../state/appEnvironment";
import { createStore, preference } from "../state/store";
import {
  normalizeLanguage,
  notifyLocaleListeners,
  resolveLocale,
  setRuntimeLocaleReader,
  type LanguagePreference,
  type Locale,
} from "./core";

export const language = preference<LanguagePreference>(
  "language",
  "auto",
  normalizeLanguage,
  (value) => value,
);

export const locale = createStore<Locale>("en");
setRuntimeLocaleReader(() => locale.get());
locale.subscribe(notifyLocaleListeners);

export function setLanguage(value: string) {
  language.set(normalizeLanguage(value));
}

function updateLocale() {
  const selected = language.get();
  const browserLanguages =
    typeof navigator !== "undefined" && Array.isArray(navigator.languages)
      ? navigator.languages
      : ["en"];
  const resolvedLocale =
    selected === "auto" ? resolveLocale(browserLanguages) : selected;
  const next = envOverrides().locale ?? resolvedLocale;
  locale.set(next);
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
  if (isDesktop) {
    void import("../nativeBridge")
      .then(({ invoke }) =>
        invoke("set_ui_locale", { locale: next, resolvedLocale }),
      )
      .catch(console.error);
  }
}

appEnvironment.subscribe(updateLocale);
language.subscribe(updateLocale);
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", updateLocale);
}
updateLocale();

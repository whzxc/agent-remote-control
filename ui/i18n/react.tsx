import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  getActiveLocale,
  subscribeLocale,
  translate,
  type Locale,
} from "./core";

const LocaleContext = createContext<Locale | null>(null);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}): ReactElement {
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}

export function useI18n(): {
  locale: Locale;
  t: (key: string, params?: Record<string, unknown>) => string;
} {
  const provided = useContext(LocaleContext);
  const active = useSyncExternalStore(
    subscribeLocale,
    getActiveLocale,
    getActiveLocale,
  );
  const current = provided ?? active;
  const boundT = useCallback(
    (key: string, params: Record<string, unknown> = {}) =>
      translate(current, key, params),
    [current],
  );
  return { locale: current, t: boundT };
}

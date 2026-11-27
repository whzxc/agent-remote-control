import {
  createContext,
  useCallback,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n/react";
import { maskSensitive, sensitiveParts } from "@/privacyMask";
import { cn } from "./utils";

export interface PrivacyContextValue {
  hidden: boolean;
  values: readonly string[];
}

const defaultPrivacy: PrivacyContextValue = {
  hidden: false,
  values: [],
};

export const PrivacyContext = createContext<PrivacyContextValue>(defaultPrivacy);

export function PrivacyProvider({
  hidden = false,
  values = [],
  children,
}: {
  hidden?: boolean;
  values?: readonly string[];
  children: ReactNode;
}): ReactElement {
  return (
    <PrivacyContext.Provider value={{ hidden, values }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacyContext(): PrivacyContextValue {
  return useContext(PrivacyContext);
}

export function usePrivacyRedactor(
  additionalValues: readonly string[] = [],
): (text: string) => string {
  const { hidden, values } = useContext(PrivacyContext);
  return useCallback(
    (text: string) => {
      if (!hidden || !text) return text;
      const targets = additionalValues.length
        ? [...values, ...additionalValues]
        : values;
      return sensitiveParts(text, targets)
        .map((part) => (part.sensitive ? maskSensitive(part.text, true) : part.text))
        .join("");
    },
    [hidden, values, additionalValues],
  );
}

export function SensitiveText({
  children = "",
  bullets = false,
  hidden: hiddenProp,
  className,
}: {
  children?: string | null;
  bullets?: boolean;
  hidden?: boolean;
  className?: string;
}): ReactElement {
  const { hidden: contextHidden } = useContext(PrivacyContext);
  const { t } = useI18n();
  const hidden = hiddenProp ?? contextHidden;
  const value = children ?? "";
  const displayed = hidden ? maskSensitive(value, bullets) : value;

  return (
    <span
      data-slot="sensitive-text"
      data-hidden={hidden || undefined}
      className={cn("inline", className)}
      aria-label={hidden && value ? t("accounts.hidden") : undefined}
    >
      <span aria-hidden={hidden || undefined}>{displayed}</span>
    </span>
  );
}

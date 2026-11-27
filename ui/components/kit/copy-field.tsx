import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../../i18n/react";
import { maskSensitive } from "../../privacyMask";
import { IconButton } from "./button";
import { SensitiveText } from "./privacy";
import { Spinner } from "./spinner";
import { cn } from "./utils";

export interface CopyFieldProps {
  value: string;
  label: string;
  password?: boolean;
  loading?: boolean;
  placeholder?: string;
  onCopy?: (value: string) => void | Promise<void>;
  className?: string;
}

export function CopyField({
  value,
  label,
  password = false,
  loading = false,
  placeholder = "",
  onCopy,
  className,
}: CopyFieldProps): ReactElement {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    if (!value) return;
    clearTimeout(timerRef.current);
    setError("");
    try {
      if (onCopy) {
        await onCopy(value);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error("Clipboard unavailable");
      }
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setError(t("copyFailedSelectAndCopyTheTextManually"));
    }
  };

  return (
    <div data-slot="copy-field" className={cn("grid w-full min-w-0 gap-1.5", className)}>
      <div className="flex h-(--kit-field-height) w-full min-w-0 items-center justify-between gap-2 rounded-kit-field border border-border bg-surface-subtle pl-3 pr-1 text-foreground">
        <div
          role="textbox"
          aria-readonly="true"
          aria-label={label}
          aria-busy={loading || undefined}
          tabIndex={0}
          onCopy={(event) => {
            event.preventDefault();
            event.clipboardData.setData("text/plain", value);
          }}
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-small outline-none",
            password && !visible && "opacity-75",
          )}
        >
          {value ? (
            <SensitiveText>
              {password && !visible ? maskSensitive(value, true) : value}
            </SensitiveText>
          ) : (
            <span className="font-sans text-text-tertiary">{placeholder}</span>
          )}
        </div>
        {loading ? (
          <span className="inline-flex size-(--kit-control-height-sm) items-center justify-center text-text-secondary">
            <Spinner size={16} />
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            {password && (
              <IconButton
                icon={visible ? EyeOff : Eye}
                label={t(visible ? "hideSecret" : "showSecret")}
                compact
                onClick={() => setVisible((prev) => !prev)}
              />
            )}
            <IconButton
              icon={copied ? Check : Copy}
              label={t(copied ? "copied" : "copy")}
              compact
              disabled={!value}
              onClick={() => void handleCopy()}
            />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-meta leading-4 text-destructive">
          {error}
        </p>
      )}
      {copied && (
        <span className="sr-only" role="status">
          {t("copied")}
        </span>
      )}
    </div>
  );
}

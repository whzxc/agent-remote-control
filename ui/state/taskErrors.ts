import { t, type MessageKey } from "../i18n";

// Keep native evidence in the task data; present actionable notices in the panel.
export function taskErrorText(error: unknown, fallback: MessageKey = "requestFailedPleaseRetry"): string {
  let value: unknown = error instanceof Error ? error.message : error;
  if (typeof value === "string") {
    const text = value.replace(/^Error:\s*/, "").trim();
    value = text;
    if (text.startsWith("{")) {
      try { value = JSON.parse(text); } catch { return t(fallback); }
    }
  }
  if (value && typeof value === "object") {
    const { code, message, guide, inputSchema } = value as { code?: unknown; message?: unknown; guide?: unknown; inputSchema?: unknown };
    if (code === "SOURCE_REVOKED") return t("detail.sourceRevoked");
    if (code === "INVALID_ARGUMENTS" || guide || inputSchema) return t(fallback);
    value = message || code;
  }
  const message = typeof value === "string" ? value : "";
  if (/\bSOURCE_REVOKED\b/.test(message)) return t("detail.sourceRevoked");
  if (!message || /^(?:Error:\s*)?[A-Z][A-Z0-9_]+(?::.*)?$/.test(message)) return t(fallback);
  return message.replace(/^Error:\s*/, "");
}

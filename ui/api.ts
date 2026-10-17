import { t } from './i18n';
import { desktopRequest, isDesktop } from './platform';
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (isDesktop) return desktopRequest<T>(path, method, body);
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-ARC-Request": "1" },
    ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(t('unrecognizedServiceResponseMakeSureTheManagementService'));
  }
  if (!response.ok)
    throw new Error(data.error || data.message || t('requestFailedPleaseRetry'));
  return data as T;
}

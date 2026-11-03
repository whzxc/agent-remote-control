import { scenarioName } from "./scenarioMode";
import { t } from './i18n';
import { desktopRequest, isDesktop } from './platform';
import { apiUrl, readOnlyBrowser } from './browserMode';
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (import.meta.env.DEV && scenarioName) return (await import('./scenarios')).scenarioResponse(path, method, body) as T;
  if (isDesktop) return desktopRequest<T>(path, method, body);
  const response = await fetch(apiUrl(path), {
    method,
    headers: { "Content-Type": "application/json", "X-ARC-Request": "1" },
    ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (readOnlyBrowser && response.status === 401) throw new Error(t('browser.accessDenied'));
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


export const accountsApi = {
  list: () => api<import('./types').AccountsResult>('accounts'),
  get: (id: string) => api<import('./types').ProviderAccount>(`accounts/${encodeURIComponent(id)}`),
  query: (args: { id?: string; agent?: string }) => api<import('./types').AccountsResult | import('./types').ProviderAccount>('accounts/query', 'POST', args),
  update: (args: { id: string; alias?: string; defaultFor?: string; default?: boolean }) => api<import('./types').ProviderAccount>('accounts/update', 'POST', args),
  merge: (args: { into: string; ids: string[]; alias?: string; quotaProviderId?: string | null }) => api<import('./types').ProviderAccount>('accounts/merge', 'POST', args),
  add: (args: { kind: 'claude' | 'codex' | 'api-key' | 'detect'; browserId?: string }) => api<import('./types').AccountLogin>('accounts/add', 'POST', args),
  login: (args: { loginId: string; action: 'code' | 'cancel'; code?: string }) => api<import('./types').AccountLogin | { submitted: boolean }>('accounts/login', 'POST', args),
  reauth: (args: { id: string; agent: string }) => api<import('./types').AccountLogin>('accounts/reauth', 'POST', args),
  remove: (args: { id: string; running: 'finish' | 'cancel' }) => api<import('./types').ProviderAccount>('accounts/remove', 'POST', args),
  browsers: () => api<{ browsers: Array<{ id: string; name: string }> }>('accounts/browsers'),
  notify: (id: string, action: 'send' | 'test', args: { target: string; message?: string }) => api(`accounts/${encodeURIComponent(id)}/${action}`, 'POST', args),
  route: (args: { accountId: string; target: string }) => api('accounts/routes', 'PUT', args),
};

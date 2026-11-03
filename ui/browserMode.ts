export const readOnlyBrowser = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-arc-browser');
const storageKey = readOnlyBrowser ? `arc.browser.key:${new URL('./', location.href).pathname}` : '';
if (readOnlyBrowser) {
  const address = new URL(location.href), key = address.searchParams.get('key');
  if (key) {
    localStorage.setItem(storageKey, key);
    address.searchParams.delete('key');
    history.replaceState(history.state, '', address);
  }
}
export function browserAuthorization(): Record<string, string> {
  const key = readOnlyBrowser && localStorage.getItem(storageKey);
  return key ? { Authorization: `Bearer ${key}` } : {};
}
export function apiUrl(path: string) {
  return readOnlyBrowser ? new URL(`./view-api/${path}`, location.href).href : `/api/${path}`;
}

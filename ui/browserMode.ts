export const readOnlyBrowser = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-arc-browser');
export function apiUrl(path: string) {
  return readOnlyBrowser ? new URL(`./view-api/${path}`, location.href).href : `/api/${path}`;
}

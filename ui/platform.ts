import { invoke, isDesktop, openExternal, writeText } from "./nativeBridge";
export { isDesktop };
export async function desktopRequest<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  return invoke<T>("service_request", {
    route: path,
    method,
    body: body ?? {},
  });
}
export async function openUrl(url: string) {
  if (url.startsWith("agent-remote-control://")) {
    window.dispatchEvent(new CustomEvent("arc:open-url", { detail: url }));
    return;
  }
  if (!isDesktop) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await openExternal(url);
}
export async function notifyNative(title: string, body: string) {
  if (!isDesktop || localStorage.getItem("notifications") === "off") return;
  await desktopRequest("permissions/notify", "POST", {title, body}).catch(() => {});
}

export async function copyText(value: string) {
  if (isDesktop) {
    await writeText(value);
  } else await navigator.clipboard.writeText(value);
}

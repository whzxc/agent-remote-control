export const isDesktop = "__TAURI_INTERNALS__" in window;
export async function desktopRequest<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
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
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
export async function notifyNative(title: string, body: string) {
  if (!isDesktop || localStorage.getItem("notifications") === "off") return;
  await desktopRequest("permissions/notify", "POST", {title, body}).catch(() => {});
}

export async function copyText(value: string) {
  if (isDesktop) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(value);
  } else await navigator.clipboard.writeText(value);
}

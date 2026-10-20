import { api } from "../api";
import { isDesktop } from "../platform";
import { createStore } from "./store";
import type { Ingress } from "./types";

export type PermissionItem = { id: string; state: string; grantTarget?: string };
export type Readiness = { items: PermissionItem[]; observedAt: string };
export const permissions = createStore<{
  data?: Readiness;
  loading: boolean;
  error: string;
}>({ loading: false, error: "" });

let pending: Promise<void> | undefined;
export function refreshPermissions(): Promise<void> {
  if (pending) return pending;
  permissions.set(previous => ({ ...previous, loading: true }));
  pending = api<Readiness>("permissions")
    .then(data => permissions.set({ data, loading: false, error: "" }))
    .catch(error => {
      permissions.set(previous => ({ ...previous, loading: false, error: String(error) }));
      throw error;
    })
    .finally(() => { pending = undefined; });
  return pending;
}

export function permissionsReady(ingresses: Ingress[]) {
  const { data, error } = permissions.get();
  if (!data || error) return false;
  const enabled = ingresses.filter(ingress => ingress.enabled);
  const permits = (tool: string) => enabled.some(ingress =>
    ingress.toolPolicy === "all" || (typeof ingress.toolPolicy === "object"
      ? ingress.toolPolicy.allowlist.includes(tool)
      : ["read", "tree", "search", "overview"].includes(tool)));
  const relevant = data.items.filter(item =>
    (["accessibility", "screen-recording"].includes(item.id) && permits("screen")) ||
    (item.id === "full-disk-access" && ["read", "tree", "search", "edit", "write"].some(permits)) ||
    (item.id === "command-full-disk-access" && permits("command")) ||
    (item.id === "notifications" && enabled.length > 0) ||
    ["codex-desktop", "codex-login", "claude-code", "login-start"].includes(item.id));
  return relevant.every(item => ["granted", "not-applicable"].includes(item.state));
}

export function startPermissions() {
  const refresh = () => { void refreshPermissions().catch(() => {}); };
  refresh();
  window.addEventListener("focus", refresh);
  let dispose: (() => void) | undefined;
  let closed = false;
  if (isDesktop) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const off = await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) refresh(); });
    if (closed) off(); else dispose = off;
  }).catch(() => {});
  return () => {
    closed = true;
    dispose?.();
    window.removeEventListener("focus", refresh);
  };
}

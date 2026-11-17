import { Globe, Link, Monitor, Shield } from "lucide-react";
import { controlSource, controlSourcePlatform } from "./controlSources";
import { locale, t } from "./i18n";
import type { ControlSource, Ingress } from "./state/types";

export function sourceDate(value?: number | null) {
  return value ? new Date(value * 1000).toLocaleString(locale.get(), { hour12: false }) : '—';
}

export function connectionKind(ingress: Ingress) {
  return ingress.transport === "local" ? "local" : ingress.transport === "relay" ? "relay" : ingress.transport === "openai-tunnel" ? "openai" : "tunnel";
}
export function connectionIcon(ingress: Ingress) {
  return { local: Monitor, relay: Link, openai: Shield, tunnel: Globe }[connectionKind(ingress)];
}
export function connectionProvider(ingress: Ingress) {
  return ingress.transport === "https" ? ingress.config.httpsProvider : t(`source.kind.${connectionKind(ingress)}`);
}
export function isPendingSource(source: ControlSource, ingresses: Ingress[]) {
  return !!source.switchSourceId || source.credential.type === "oauth-grant" && ingresses.some(i => i.id === source.ingressId && i.oauth?.pending.some(p => p.sourceId === source.id));
}
export function sourceCandidates(sources: ControlSource[], ingresses: Ingress[], ingressId: string, product: string, pendingId?: string) {
  return sources.filter(s => s.id !== pendingId && s.ingressId === ingressId && s.product === product && s.credential.type === "oauth-grant" && !isPendingSource(s, ingresses)
    && (s.state === "revoked" || s.connectedAt !== null || ingresses.find(i => i.id === ingressId)?.oauth?.grants.some(g => g.id === s.credential.grantId)));
}

// A non-OAuth connection has exactly one identity. Never silently reuse an occupied one.
export function connectionDisabledReason(ingress: Ingress, product: string, sources: ControlSource[], localTarget?: "code" | "desktop") {
  if (localTarget && ingress.id !== `local-claude-${localTarget}`) return t("setup.localOnly");
  if (!localTarget && ingress.transport === "local") return t("setup.localOnly");
  if (ingress.transport === "openai-tunnel" && product !== "chatgpt") return t("setup.chatgptOnly");
  const auth = controlSource(product)?.supportedAuth;
  if (ingress.transport !== "local" && auth && !auth.includes(ingress.auth)) return t("setup.authUnsupported", { auth: ingress.auth });
  if (ingress.auth !== "oauth" && sources.some(s => s.retiredIngressIds?.includes(ingress.id))) return t("switch.retiredConnection");
  if (ingress.auth !== "oauth" && sources.some(s => s.ingressId === ingress.id && (s.state === "revoked" || s.connectedAt !== null || s.lastSeenAt !== null))) return t("setup.connectionOccupied");
  return "";
}

export function isLocalSource(source: ControlSource) {
  return source.ingressId === "local-cli" && source.credential.type === "local";
}

export function platformSources(sources: ControlSource[], ingresses: Ingress[], platform: string) {
  return sources.filter(source => source.product && controlSourcePlatform(source.product).id === platform
    && source.state !== 'revoked' && !isLocalSource(source) && !isPendingSource(source, ingresses));
}

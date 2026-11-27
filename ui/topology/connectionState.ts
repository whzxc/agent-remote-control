import type { Agent } from "../state/agents";
import type { ControlSource, Ingress } from "../state/types";
import type { WireState } from "./render";

export type ConnectionState =
  | "connected"
  | "connectingLabel"
  | "preparing"
  | "connectionError"
  | "disabled"
  | "disconnected";

export function ingressState(entry: Pick<Ingress, "enabled" | "state">): ConnectionState {
  if (!entry.enabled) return "disabled";
  if (entry.state === "ready") return "connected";
  if (entry.state === "starting" || entry.state === "stopping") return "connectingLabel";
  if (entry.state === "error" || entry.state === "degraded") return "connectionError";
  return "disconnected";
}

export function isSourceAuthorized(source: ControlSource, ingress: Ingress): boolean {
  if (source.connectionRemoved || source.state === "revoked") return false;
  if (source.credential.type !== "oauth-grant") return true;
  if (source.switchSourceId || ingress.oauth?.pending.some(p => p.sourceId === source.id)) return false;
  return source.connectedAt !== null || !!ingress.oauth?.grants.some(g => g.id === source.credential.grantId);
}

export function sourceConnectionState(source: ControlSource, ingress: Ingress): ConnectionState {
  if (!isSourceAuthorized(source, ingress)) return "disconnected";
  return ingressState(ingress);
}

export function agentConnectionState(agent: Pick<Agent, "installed" | "enabled" | "available" | "adapter">): ConnectionState {
  if (agent.adapter?.state === "preparing") return "preparing";
  if (agent.adapter?.state === "failed") return "connectionError";
  if (!agent.installed || !agent.enabled) return "disabled";
  return agent.available ? "connected" : "connectionError";
}

export function wireState(state: string): WireState {
  if (state === "connected") return "normal";
  if (state === "connectingLabel" || state === "preparing") return "connecting";
  if (state === "connectionError") return "error";
  return "inactive";
}

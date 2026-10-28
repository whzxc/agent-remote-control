import { onboarding, connectionSetup } from "./onboarding";
import { createStore } from "./store";
import { agentPanelSelection, type AgentPanelSelection, type AgentPanelAction } from "./activityModel";
import { sourcePlatformNodeId } from "../topology/accounts";
import type { Ingress } from "./types";

export const agentPanel = createStore<AgentPanelSelection>(undefined);
export function agentPanelId(selection: NonNullable<AgentPanelSelection>) {
  return `${selection.agent}:${selection.platform ? 'platform' : selection.accountId ?? ''}`;
}
export type IngressConnectionSelection = { client?: { id: string; name: string; source: string }; ingress: Ingress; editing?: boolean; field?: string; autoConnect?: boolean; closing?: boolean };
export type SourcePlatformSelection = { platform: string; closing?: boolean };
export type IngressPanelSelection = IngressConnectionSelection | SourcePlatformSelection;
export function sourcePanelId(selection: IngressPanelSelection) {
  return 'platform' in selection ? sourcePlatformNodeId(selection.platform) : selection.client?.id ?? selection.ingress.id;
}
export const ingressPanel = createStore<IngressPanelSelection | undefined>(undefined);
export function selectAgentPanel(action: AgentPanelAction) {
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  if (["agent", "toggle", "task", "platform"].includes(action.type)) ingressPanel.set(undefined);
  agentPanel.set(old => agentPanelSelection(old, action));
}
export function selectIngressPanel(ingress: Ingress, options: { client?: IngressConnectionSelection["client"]; editing?: boolean; field?: string; autoConnect?: boolean; toggle?: boolean } = {}) {
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  agentPanel.set(undefined);
  ingressPanel.set(old => {
    const current = old && 'ingress' in old ? old : undefined;
    return options.toggle && current?.ingress.id === ingress.id && current.client?.id === options.client?.id
      ? { ...current, closing: true }
      : { ingress, client: options.client ?? (current?.ingress.id === ingress.id ? current.client : undefined), editing: options.editing, field: options.field, autoConnect: options.autoConnect };
  });
}
export function selectSourcePlatform(platform: string, toggle = false) {
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  agentPanel.set(undefined);
  ingressPanel.set(old => toggle && old && 'platform' in old && old.platform === platform ? { ...old, closing: true } : { platform });
}

import { layers } from "./layers";
import { onboarding, connectionSetup } from "./onboarding";
import { createStore } from "./store";
import { accounts } from "./accounts";
import { agentPanelSelection, type AgentPanelSelection, type AgentPanelAction } from "./activityModel";
import { sourcePlatformNodeId } from "../topology/accounts";
import type { Ingress } from "./types";

export const panelBack = createStore<{ label: string; open: () => void } | undefined>(undefined);
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
export function managesAgentAccounts(agent: string): agent is "claude" | "codex" {
  return agent === "claude" || agent === "codex";
}
export function selectAgentPanel(action: AgentPanelAction) {
  if (action.type === 'back' && panelBack.get()) { const back = panelBack.get()!; layers.switchPanel(() => { panelBack.set(undefined); agentPanel.set(undefined); back.open(); }); return; }
  if (action.type === 'platform' && !managesAgentAccounts(action.agent)) {
    const agent = action.agent;
    const linked = accounts.get().items.filter(account => account.agentProfiles.some(profile => profile.agent === agent));
    if (linked.length <= 1) action = { type: action.toggle ? 'toggle' : 'agent', agent: action.agent, accountId: linked[0]?.id };
  }
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  const next = agentPanelSelection(agentPanel.get(), action);
  const open = () => { if (!['task', 'back'].includes(action.type)) panelBack.set(undefined); agentPanel.set(next?.closing ? undefined : next); };
  const panel = layers.get().find(layer => layer.kind === 'panel');
  if (action.type === "toggle" || (action.type === "platform" || action.type === "task") && action.toggle || panel?.dirty || panel?.busy) layers.switchPanel(open, !next || !!next.closing);
  else open();
}
export function selectIngressPanel(ingress: Ingress, options: { client?: IngressConnectionSelection["client"]; editing?: boolean; field?: string; autoConnect?: boolean; toggle?: boolean } = {}) {
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  const old = ingressPanel.get();
  const current = old && 'ingress' in old ? old : undefined;
  const next = options.toggle && current?.ingress.id === ingress.id && current.client?.id === options.client?.id
      ? undefined
      : { ingress, client: options.client ?? (current?.ingress.id === ingress.id ? current.client : undefined), editing: options.editing, field: options.field, autoConnect: options.autoConnect };
  if (options.toggle) layers.switchPanel(() => ingressPanel.set(next), !next); else ingressPanel.set(next);
}
export function selectSourcePlatform(platform: string, toggle = false) {
  connectionSetup.set(undefined);
  onboarding.set(undefined);
  const old = ingressPanel.get();
  const next = toggle && old && 'platform' in old && old.platform === platform ? undefined : { platform };
  if (toggle) layers.switchPanel(() => ingressPanel.set(next), !next); else ingressPanel.set(next);
}

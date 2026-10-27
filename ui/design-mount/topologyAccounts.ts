import type { AgentActivitySnapshot, ProviderAccount } from '../types';
import type { Status } from '../state/types';

export function installTopologyAccounts(status: Status, activity: AgentActivitySnapshot): ProviderAccount[] {
  const base = status.ingresses[0].sources![0];
  const identities: Pick<ProviderAccount, 'id' | 'provider' | 'identityKey' | 'alias' | 'sources' | 'agentProfiles'>[] = [
    { id: 'example-personal', provider: 'anthropic', identityKey: 'example-anthropic-personal', alias: 'Personal', sources: ['example-claude-personal', 'example-claude-laptop'], agentProfiles: [{ agent: 'claude', profileId: 'example-profile-personal', kind: 'cli-profile', state: 'signed-in', default: true }] },
    { id: 'example-studio', provider: 'anthropic', identityKey: 'example-anthropic-studio', alias: 'Studio', sources: ['example-claude-studio'], agentProfiles: [{ agent: 'claude', profileId: 'example-profile-studio', kind: 'cli-profile', state: 'signed-in', default: false }] },
    { id: 'example-openai', provider: 'openai', identityKey: 'example-openai', alias: 'Personal', sources: ['example-chatgpt'], agentProfiles: [{ agent: 'codex', profileId: 'example-codex-home', kind: 'codex-home', state: 'signed-in', default: true }] },
    { id: 'example-deepseek', provider: 'deepseek', identityKey: 'example-deepseek', alias: 'Project', sources: [], agentProfiles: [{ agent: 'dsh', profileId: 'example-key', kind: 'api-key', state: 'signed-in', default: true }] },
    { id: 'example-unidentified-one', provider: 'anthropic', identityKey: 'anthropic:unidentified:example-source-one', alias: 'Unidentified', sources: ['example-source-one'], agentProfiles: [] },
    { id: 'example-unidentified-two', provider: 'anthropic', identityKey: 'anthropic:unidentified:example-source-two', alias: 'Unidentified', sources: ['example-source-two'], agentProfiles: [] },
  ];
  const accounts = identities.map((identity): ProviderAccount => ({
    ...identity, createdAt: activity.observedAt, observedAt: activity.observedAt,
    notifications: { state: identity.sources.length ? identity.provider === 'openai' ? 'mcp-events' : 'not-bound' : 'n/a',
      reachable: identity.provider === 'openai', sessions: [] },
    quota: ['anthropic', 'openai'].includes(identity.provider) && identity.agentProfiles.length ? {
      state: 'ready', observedAt: activity.observedAt,
      windows: [
        { id: 'five-hour', poolId: 'main', label: 'five_hour', usedPercent: identity.id === 'example-personal' ? 18 : 58,
          resetsAt: new Date(Date.parse(activity.observedAt) + 2 * 3600000).toISOString() },
        { id: 'weekly', poolId: 'main', label: 'weekly', usedPercent: identity.id === 'example-personal' ? 27 : 73,
          resetsAt: new Date(Date.parse(activity.observedAt) + 3 * 86400000).toISOString() },
      ],
    } : { state: 'unavailable', windows: [] },
    health: { state: identity.sources.length && identity.provider === 'anthropic' ? 'attention' : 'ready' },
  }));
  status.ingresses[0].sources = accounts.flatMap(a => a.sources.map(id => ({ ...base, id, product: a.provider === 'openai' ? 'chatgpt' : 'claude', label: id === 'example-source-one' ? 'Claude · Laptop' : id === 'example-source-two' ? 'Claude · Desktop' : a.provider === 'openai' ? 'Personal' : 'Claude' })));
  for (const [agent, group] of Object.entries(activity.agents)) group.sessions.forEach((session, index) => {
    const account = agent === 'claude' ? accounts[index === 1 ? 1 : 0] : agent === 'codex' ? accounts[2] : accounts[3];
    session.agentAccountId = account.id;
    const origin = agent === 'dsh' ? accounts[1] : account;
    session.origin = { accountId: origin.id, sourceId: origin.sources[0], ingressId: base.ingressId };
    if (session.dispatchSummary) {
      session.dispatchSummary.agentAccountId = account.id;
      session.dispatchSummary.controlSource = { id: origin.sources[0], kind: origin.provider === 'openai' ? 'chatgpt' : 'claude', label: origin.provider === 'openai' ? 'ChatGPT' : 'Claude' };
    }
  });
  return accounts;
}

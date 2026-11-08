import type { AgentActivitySnapshot, ProviderAccount } from '../types';
import type { Status } from '../state/types';
import type { TopologyAccount } from './accounts';

export function installTopologyAccounts(status: Status, activity: AgentActivitySnapshot): ProviderAccount[] {
  const base = status.ingresses[0].sources![0];
  const identities: Omit<TopologyAccount, 'quota'>[] = [
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
    quota: identity.provider === 'anthropic' && identity.agentProfiles.length ? {
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

export function installDenseTopologyAccounts(status: Status, activity: AgentActivitySnapshot, portrait = false): ProviderAccount[] {
  const ingress = status.ingresses[0];
  const original = ingress.sources!;
  const accounts = installTopologyAccounts(status, activity);
  if (portrait) {
    ingress.sources = [
      ...ingress.sources!.filter(source => source.product === 'chatgpt' || source.id.startsWith('example-source-')),
      ...original.filter(source => source.product === 'google' || source.product === 'xai'),
    ];
  }
  const sources = accounts.map(account => ({ ...account,
    sources: account.sources.filter(id => ingress.sources!.some(source => source.id === id)),
    agentProfiles: portrait ? account.agentProfiles.filter(profile => profile.agent === 'claude') : [],
  }));
  const observedAt = activity.observedAt;
  const used = portrait ? [27, 100, ...Array<number>(10).fill(18)] : [27, 62, 19, 27, 18, 62, 35, 100, 22, 73, undefined];
  const codex = used.map((usedPercent, index): ProviderAccount => ({
    id: `example-codex-${String(index).padStart(2, '0')}`, provider: 'openai', identityKey: `example-codex-${index}`,
    alias: index === 0 ? 'Pro 200' : `Codex Pro ${String(index).padStart(2, '0')}`,
    sources: [], agentProfiles: [{ agent: 'codex', profileId: `example-codex-profile-${index}`, kind: 'codex-home', state: 'signed-in', default: index === 0 }],
    createdAt: observedAt, observedAt, notifications: { state: 'n/a', reachable: false, sessions: [] }, health: { state: 'ready' },
    quota: usedPercent === undefined ? { state: 'unavailable', windows: [] } : { state: 'ready', observedAt,
      windows: [{ id: 'weekly', poolId: 'main', label: 'weekly', usedPercent,
        resetsAt: new Date(Date.parse(observedAt) + 3 * 86400000).toISOString() }] },
  }));
  const origin = sources.find(account => account.provider === 'openai')!;
  activity.agents.codex.sessions.forEach((session, index) => {
    session.agentAccountId = codex[index < 2 ? 0 : index - 1].id;
    session.origin = { accountId: origin.id, sourceId: origin.sources[0], ingressId: status.ingresses[0].id };
    if (session.dispatchSummary) {
      session.dispatchSummary.agentAccountId = session.agentAccountId;
      session.dispatchSummary.controlSource = { id: origin.sources[0], kind: 'chatgpt', label: 'ChatGPT' };
    }
  });
  return [...sources, ...codex];
}

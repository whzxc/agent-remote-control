import type { AgentActivitySnapshot, ProviderAccount } from '../types';
import type { Status } from '../state/types';

export function installTopologyAccounts(status: Status, activity: AgentActivitySnapshot): ProviderAccount[] {
  const base = status.ingresses[0].sources![0];
  const identities: Pick<ProviderAccount, 'id' | 'provider' | 'identityKey' | 'alias' | 'sources' | 'agentProfiles'>[] = [
    { id: 'example-personal', provider: 'anthropic', identityKey: 'example-anthropic-personal', alias: 'Personal', sources: ['example-claude-personal', 'example-claude-laptop'], agentProfiles: [{ agent: 'claude', profileId: 'example-profile-personal', kind: 'cli-profile', state: 'signed-in', default: true }] },
    { id: 'example-studio', provider: 'anthropic', identityKey: 'example-anthropic-studio', alias: 'Studio', sources: ['example-claude-studio'], agentProfiles: [{ agent: 'claude', profileId: 'example-profile-studio', kind: 'cli-profile', state: 'signed-in', default: false }] },
    { id: 'example-openai', provider: 'openai', identityKey: 'example-openai', alias: 'Personal', sources: ['example-chatgpt'], agentProfiles: [] },
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
    const origin = agent === 'claude' ? accounts[index === 1 ? 1 : 0] : agent === 'codex' ? accounts[2] : accounts[1];
    session.origin = { accountId: origin.id, sourceId: origin.sources[0], ingressId: base.ingressId };
    if (session.dispatchSummary) {
      session.dispatchSummary.controlSource = { id: origin.sources[0], kind: origin.provider === 'openai' ? 'chatgpt' : 'claude', label: origin.provider === 'openai' ? 'ChatGPT' : 'Claude' };
    }
  });
  return accounts;
}

export function installDenseTopologyAccounts(status: Status, activity: AgentActivitySnapshot): ProviderAccount[] {
  const ingress = status.ingresses[0];
  const base = ingress.sources![0];
  const original = ingress.sources!;
  const accounts = installTopologyAccounts(status, activity);
  const extraSources = Array.from({ length: 10 }, (_, index) => ({
    ...base,
    id: `example-claude-pro-${String(index).padStart(2, '0')}`,
    platform: 'anthropic',
    product: 'claude',
    label: `Claude Pro ${String(index).padStart(2, '0')}`,
  }));
  ingress.sources = [
    ...ingress.sources!.filter(source => source.product === 'chatgpt' || source.id.startsWith('example-source-')),
    ...extraSources,
    ...original.filter(source => source.product === 'google' || source.product === 'xai'),
  ];
  const sources = accounts.map(account => ({ ...account,
    sources: account.sources.filter(id => ingress.sources!.some(source => source.id === id)),
    agentProfiles: account.agentProfiles.filter(profile => profile.agent === 'claude'),
  }));
  const observedAt = activity.observedAt;
  const extraAccounts = extraSources.map((source, index): ProviderAccount => ({
    id: `example-claude-extra-${String(index).padStart(2, '0')}`,
    provider: 'anthropic',
    identityKey: `example-claude-extra-${index}`,
    alias: source.label,
    sources: [source.id],
    agentProfiles: [],
    createdAt: observedAt,
    observedAt,
    notifications: { state: 'not-bound', reachable: false, sessions: [] },
    health: { state: 'ready' },
    quota: { state: 'unavailable', windows: [] },
  }));
  const origin = sources.find(account => account.provider === 'openai')!;
  activity.agents.codex.sessions.forEach(session => {
    session.origin = { accountId: origin.id, sourceId: origin.sources[0], ingressId: status.ingresses[0].id };
    if (session.dispatchSummary) {
      session.dispatchSummary.controlSource = { id: origin.sources[0], kind: 'chatgpt', label: 'ChatGPT' };
    }
  });
  return [...sources, ...extraAccounts];
}

export function installDevicePortraitAccounts(status: Status, activity: AgentActivitySnapshot): ProviderAccount[] {
  const base = status.ingresses[0].sources![0];
  const groups = [
    { platform: 'anthropic', product: 'claude', agent: 'claude', aliases: ['Personal', 'Review'] },
    { platform: 'xai', product: 'xai', agent: undefined, aliases: ['Personal', 'Work'] },
    { platform: 'openai', product: 'chatgpt', agent: undefined, aliases: ['Pro', 'Studio'] },
  ];
  const accounts = groups.flatMap(group => group.aliases.map((alias, index): ProviderAccount => ({
    id: `portrait-${group.platform}-${index}`, provider: group.platform, identityKey: `portrait-${group.platform}-${index}`,
    alias, sources: [`portrait-source-${group.platform}-${index}`],
    agentProfiles: group.agent ? [{ agent: group.agent, profileId: `portrait-profile-${group.platform}-${index}`, kind: 'cli-profile', state: 'signed-in', default: index === 0 }] : [],
    createdAt: activity.observedAt, observedAt: activity.observedAt, health: { state: 'ready' },
    notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] },
  })));
  status.ingresses[0].sources = groups.flatMap(group => group.aliases.map((alias, index) => ({
    ...base, id: `portrait-source-${group.platform}-${index}`, platform: group.platform, product: group.product, label: alias,
  })));
  for (const [, group] of Object.entries(activity.agents)) for (const session of group.sessions) {
    session.origin = { sourceId: 'portrait-source-anthropic-0', ingressId: base.ingressId };
  }
  return accounts;
}

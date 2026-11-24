import { accountQuotaProvider } from '../subscriptions/accountQuota';
import type { ProviderSnapshot, Snapshot } from '../subscriptions/types';
import type { ProviderAccount } from '../types';
import { platformQuotaForAgent } from './subscriptions';

type ResolvedQuota = ProviderSnapshot & { quotaAccountId?: string };

function hasUsableWindows(quota: Pick<ProviderSnapshot, 'windows'>, now = Date.now()) {
  return quota.windows.some(window => Number.isFinite(window.usedPercent)
    && (!window.resetsAt || Date.parse(window.resetsAt) > now));
}

function hasReadyAccountQuota(account: ProviderAccount) {
  return account.quota.state === 'ready' && !account.quota.error && hasUsableWindows(account.quota);
}

export function resolveAgentQuota(agentId: string, snapshot: Snapshot | undefined, accounts: readonly ProviderAccount[]): ResolvedQuota | undefined {
  const provider = platformQuotaForAgent(snapshot, agentId);
  if (provider?.state === 'ready' && !provider.error) return provider;

  const candidates = accounts.filter(account => account.health.state !== 'removed'
    && account.agentProfiles.some(profile => profile.agent === agentId && profile.state === 'signed-in'));
  const defaults = candidates.filter(account => account.agentProfiles.some(profile =>
    profile.agent === agentId && profile.state === 'signed-in' && profile.default));
  const selected = defaults.length === 1 ? defaults[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (selected && hasReadyAccountQuota(selected)) {
    return { ...accountQuotaProvider(agentId, selected.quota), quotaAccountId: selected.id };
  }
  return provider;
}

export function resolveSourceQuota(sourceId: string, snapshot: Snapshot | undefined, accounts: readonly ProviderAccount[]): ProviderSnapshot | undefined {
  const active = accounts.filter(account => account.health.state !== 'removed');
  const account = active.find(account => account.sources.includes(sourceId));
  if (!account) return;
  const providers = snapshot?.settings.enabled ? snapshot.providers : [];
  const onlyProviderAccount = active.filter(candidate => candidate.provider === account.provider).length === 1;
  const profile = account.agentProfiles.find(profile => profile.state === 'signed-in' && profile.default)
    ?? account.agentProfiles.find(profile => profile.state === 'signed-in');
  const shared = account.quotaProviderId
    ? providers.find(provider => provider.providerId === account.quotaProviderId)
    : onlyProviderAccount && profile
      ? providers.find(provider => provider.eligible && provider.agentId === profile.agent)
      : undefined;
  const agent = shared?.agentId ?? profile?.agent ?? account.quotaProviderId;
  if (agent && hasReadyAccountQuota(account)) return accountQuotaProvider(agent, account.quota);
  if (shared || account.quotaProviderId) return shared;
  if (!profile) return;
  const signedIn = active.filter(candidate => candidate.agentProfiles.some(item => item.agent === profile.agent && item.state === 'signed-in'));
  if (signedIn.length === 1) return resolveAgentQuota(profile.agent, snapshot, accounts);
}

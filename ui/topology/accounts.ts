import type { ProviderAccount } from '../types';

export type TopologyAccount = Pick<ProviderAccount, 'id' | 'provider' | 'identityKey' | 'alias' | 'sources' | 'agentProfiles' | 'quota'>;
export const sourcePlatformNodeId = (platform: string) => `platform:${platform}`;
export const accountNodeId = (platform: string, account: string) => JSON.stringify(['account', platform, account]);

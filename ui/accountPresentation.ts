import type { ProviderAccount } from './types';

export function accountOwns(account: Pick<ProviderAccount, 'id' | 'mergedAccountIds'>, id?: string | null) {
  return !!id && (account.id === id || account.mergedAccountIds?.includes(id) === true);
}

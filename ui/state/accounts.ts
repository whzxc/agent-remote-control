import { useEffect } from 'react';
import { accountsApi } from '../api';
import type { ProviderAccount as Account, AccountLogin } from '../types';
import { createStore } from './store';
import { connector } from './connector';
import { isLocalSource } from '../sourcePresentation';
import type { ControlSource } from './types';
export const accounts = createStore<{ items: Account[]; login: AccountLogin | null; loading: boolean; error: string }>({ items: [], login: null, loading: true, error: '' });
let pending: Promise<void> | undefined;
let consumers = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
export function boundNotificationSessions(account: Account) {
  return account.notifications.sessions.filter(session => session.target.trim().length > 0);
}
export function controlSourceAccounts(items: Account[], sources: ControlSource[]) {
  const local = new Set(sources.filter(isLocalSource).map(source => source.id));
  return items.map(account => ({ ...account, sources: account.sources.filter(id => !local.has(id)) }))
    .filter((account, index) => account.sources.length > 0 || account.agentProfiles.length > 0 || !items[index].sources.some(id => local.has(id)));
}
export function refreshAccounts() {
  return pending ??= (async () => {
    try {
      const { accounts: rows, login } = await accountsApi.list();
      const items = await Promise.all(rows.map(row => accountsApi.get(row.id)));
      accounts.set({ items: controlSourceAccounts(items, connector.get().sources).map(account => ({ ...account, notifications: { ...account.notifications, sessions: boundNotificationSessions(account) } })), login, loading: false, error: '' });
    } catch (error) { accounts.set(old => ({ ...old, loading: false, error: String(error) })); }
    finally { pending = undefined; }
  })();
}
export function useAccounts() {
  const state = accounts.use();
  useEffect(() => {
    if (++consumers === 1) {
      void refreshAccounts();
      // Native account details cache profile quota reads for three minutes.
      pollTimer = setInterval(() => void refreshAccounts(), 10000);
    }
    return () => {
      if (--consumers === 0) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };
  }, []);
  return state;
}

export function isUnidentified(account: Account) { return account.identityKey.includes(':unidentified:'); }

import { useEffect } from 'react';
import { api } from '../api';
import { createStore } from './store';

export type CatalogOption = { id: string; category?: string; values?: (string | { value: string; name?: string })[] };
export type CatalogModel = { model: string; name?: string; displayName?: string; provider?: { id: string; name: string }; contextWindow?: number | number[]; group?: string; options?: CatalogOption[] };
export type DispatchCatalog = {
  authoritative?: boolean;
  source?: string;
  unavailable?: string;
  currentModel?: string;
  optionsForModel?: string;
  models?: CatalogModel[] | { unavailable: string };
  options?: CatalogOption[];
};
export type CatalogState = { status: 'loading' | 'ready' | 'error'; catalog?: DispatchCatalog };
const catalogs = createStore<Record<string, CatalogState>>({});
const refreshed = new Map<string, number>();
const pending = new Set<string>();

/** Deduplicate readers, retain labels during refresh, and retry on a later mount. */
export function useDispatchCatalog(agent: string, taskId?: string, enabled = true): CatalogState | undefined {
  const key = JSON.stringify([agent, taskId]);
  const values = catalogs.use();
  useEffect(() => {
    if (!enabled || !agent || pending.has(key) || Date.now() - (refreshed.get(key) ?? -Infinity) < 60_000) return;
    pending.add(key);
    catalogs.set(old => ({ ...old, [key]: { status: 'loading', catalog: old[key]?.catalog } }));
    void api<DispatchCatalog>('agents/dispatch-catalog', 'POST', { agent, ...(taskId ? { taskId } : {}) })
      .then(catalog => catalogs.set(old => ({ ...old, [key]: { status: 'ready', catalog } })))
      .catch(() => catalogs.set(old => ({ ...old, [key]: { status: 'error', catalog: old[key]?.catalog } })))
      .finally(() => { pending.delete(key); refreshed.set(key, Date.now()); });
  }, [agent, taskId, enabled, key]);
  return enabled ? values[key] : undefined;
}

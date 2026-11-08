import { api } from '../api';
import { createStore } from '../state/store';
import { ownerResult } from './state';
import type { AXEntry, AXPage } from './axModel';

export const axObservation = createStore<{ entries: AXEntry[]; observedAt?: string; loading: boolean; error: string }>({ entries: [], loading: false, error: '' });
let pending: Promise<void> | undefined;
let generation = 0;
export function resetAX() { generation++; pending = undefined; axObservation.set({ entries: [], loading: false, error: '' }); }
export function refreshAX(): Promise<void> {
  if (pending) return pending;
  const before = generation;
  axObservation.set(old => ({ ...old, loading: true }));
  const read = (async () => {
    try {
      // An AX mutation invalidates the owner's cursor. Retry the whole snapshot
      // once; never publish a mixture of revisions or a partially loaded count.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const entries: AXEntry[] = [];
          let cursor: string | null | undefined, page: AXPage;
          do {
            page = ownerResult(await api<AXPage>('coordination/ax_list', 'POST', { limit: 100, ...(cursor ? { cursor } : {}) }));
            entries.push(...page.entries);
            cursor = page.nextCursor;
          } while (cursor && before === generation);
          if (before === generation) axObservation.set({ entries, observedAt: page.observedAt, loading: false, error: '' });
          break;
        } catch (error) {
          if (attempt === 0 && String(error).includes('AX_CURSOR_EXPIRED')) continue;
          throw error;
        }
      }
    } catch (error) { if (before === generation) axObservation.set(old => ({ ...old, loading: false, error: String(error) })); }
    finally { if (before === generation) pending = undefined; }
  })();
  pending = read;
  return read;
}

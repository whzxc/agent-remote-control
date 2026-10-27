import { preference } from '../state/store';
// Existing persisted ordering is read-only on the arena.
export const topologyAccountOrder = preference<Record<string, string[]>>('arc.topology-account-order', {}, raw => {
  const value = JSON.parse(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === 'string'))) : {};
});

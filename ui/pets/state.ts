import { api } from '../api';
import { createStore, preference } from '../state/store';
import type { PetPackage } from './model';
export const showPets = preference('arc.pets.show', false);
export const petAssignments = preference<Record<string, string>>('arc.pets.assignments', {});
export const petLibrary = createStore<{ packages: PetPackage[]; errors: { key: string; error: string }[]; loading: boolean; error: string }>({ packages: [], errors: [], loading: false, error: '' });
export const petAssets = createStore<Record<string, string>>({});
const pending = new Map<string, Promise<void>>();
export async function petAsset(key: string) {
  if (petAssets.get()[key]) return;
  if (pending.has(key)) return pending.get(key);
  const read = api<{ dataUrl: string }>('pets/asset', 'POST', { key }).then(({ dataUrl }) => { petAssets.set(old => ({ ...old, [key]: dataUrl })); }).finally(() => pending.delete(key));
  pending.set(key, read); return read;
}
export async function refreshPets() {
  petLibrary.set(old => ({ ...old, loading: true, error: '' }));
  try { const value = await api<Pick<ReturnType<typeof petLibrary.get>, 'packages' | 'errors'>>('pets'); petLibrary.set({ ...value, loading: false, error: '' }); }
  catch (error) { petLibrary.set(old => ({ ...old, loading: false, error: String(error) })); }
}
export async function installPet(body: { url: string } | { zip: string }) {
  const value = await api<Pick<ReturnType<typeof petLibrary.get>, 'packages' | 'errors'>>('url' in body ? 'pets/install' : 'pets/import', 'POST', body);
  petLibrary.set({ ...value, loading: false, error: '' });
}
export function assignPet(id: string, key: string) {
  petAssignments.set(old => { const next = { ...old }; if (key) next[id] = key; else delete next[id]; return next; });
}

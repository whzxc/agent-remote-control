import { api } from '../api';
import { createStore, preference } from '../state/store';
import type { PetPackage } from './model';
import { builtinAssets, builtinPets, withBuiltinPets } from './builtins';
export const showPets = preference('arc.pets.show', false);
export const petAssignments = preference<Record<string, string>>('arc.pets.assignments', {});
export const petLibrary = createStore<{ packages: PetPackage[]; errors: { key: string; error: string }[]; loading: boolean; error: string }>({ packages: builtinPets, errors: [], loading: false, error: '' });
export const petAssets = createStore<Record<string, string>>({ ...builtinAssets });
const pending = new Map<string, Promise<void>>();
export async function petAsset(key: string) {
  if (Object.hasOwn(builtinAssets, key)) { if (!petAssets.get()[key]) petAssets.set(old => ({ ...old, [key]: builtinAssets[key] })); return; }
  if (petAssets.get()[key]) return;
  if (pending.has(key)) return pending.get(key);
  const read = api<{ dataUrl: string }>('pets/asset', 'POST', { key }).then(({ dataUrl }) => { petAssets.set(old => ({ ...old, [key]: dataUrl })); }).finally(() => pending.delete(key));
  pending.set(key, read); return read;
}
export async function refreshPets() {
  petLibrary.set(old => ({ ...old, packages: withBuiltinPets(old.packages), loading: true, error: '' }));
  try { const value = await api<Pick<ReturnType<typeof petLibrary.get>, 'packages' | 'errors'>>('pets'); petLibrary.set({ ...value, packages: withBuiltinPets(value.packages), loading: false, error: '' }); }
  catch (error) { petLibrary.set(old => ({ ...old, loading: false, error: String(error) })); }
}
export async function installPet(body: { url: string } | { zip: string }) {
  const value = await api<Pick<ReturnType<typeof petLibrary.get>, 'packages' | 'errors'>>('url' in body ? 'pets/install' : 'pets/import', 'POST', body);
  petLibrary.set({ ...value, packages: withBuiltinPets(value.packages), loading: false, error: '' });
}
export function assignPet(id: string, key: string) {
  petAssignments.set(old => { const next = Object.fromEntries(Object.entries(old).filter(([id]) => !id.startsWith('brand:'))); if (key) next[id] = key; else delete next[id]; return next; });
}

export async function removePet(key: string) {
  if (Object.hasOwn(builtinAssets, key)) throw new Error('INVALID_ARGUMENT: built-in companions cannot be removed; choose another pet or turn pets off');
  const value = await api<Pick<ReturnType<typeof petLibrary.get>, 'packages' | 'errors'>>('pets/remove', 'POST', { key });
  petLibrary.set({ ...value, packages: withBuiltinPets(value.packages), loading: false, error: '' });
  petAssets.set(old => { const next = { ...old }; delete next[key]; return next; });
  petAssignments.set(old => Object.fromEntries(Object.entries(old).filter(([, value]) => value !== key)));
}

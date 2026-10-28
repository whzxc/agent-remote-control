import type { PetPackage } from './model';

export const builtinPets: PetPackage[] = [
  { key: 'builtin:clawd', id: 'arc-clawd', name: 'Clawd', description: 'The warm, curious Loop companion.', mascot: 'clawd', version: 2, origin: 'builtin', pixelArt: false, source: { site: 'ARC' } },
  { key: 'builtin:codex', id: 'arc-codex', name: 'Codex', description: 'A small terminal with a cloud-shaped body.', mascot: 'codex', version: 2, origin: 'builtin', pixelArt: false, source: { site: 'ARC' } },
];
// SVG mascots have no fetched atlas. A non-network marker keeps asset readiness
// uniform for previews and actors while the sprite chooses its native renderer.
export const builtinAssets: Record<string, string> = Object.fromEntries(builtinPets.map(pet => [pet.key, pet.key]));
export function withBuiltinPets(packages: PetPackage[]): PetPackage[] {
  return [...builtinPets, ...packages.filter(pet => !Object.hasOwn(builtinAssets, pet.key))];
}

export type PetBrand = 'claude' | 'codex' | 'other';
export type MascotKind = 'clawd' | 'codex';
export interface PetPackage {
  key: string; id: string; name: string; description?: string | null; version: 1 | 2; origin: 'arc' | 'codex' | 'builtin'; pixelArt: boolean; mascot?: MascotKind;
  source: { site: string; pageUrl?: string | null; author?: string | null; license?: string | null; attribution?: string | null; installedAt?: string; sha256?: { petJson: string; spritesheet: string } };
}
export interface Participant { id: string; name: string; brand: PetBrand; kind: 'source' | 'agent'; nativeId: string; platform?: string }
export interface Point { x: number; y: number }
export function petBrand(product: string): PetBrand {
  if (['claude', 'claude-code', 'claude-desktop', 'claude-web', 'anthropic'].includes(product)) return 'claude';
  if (['codex', 'chatgpt', 'chatgpt-web', 'chatgpt-desktop', 'openai'].includes(product)) return 'codex';
  return 'other';
}
export function defaultPet(packages: PetPackage[], assignments: Record<string, string>): PetPackage | undefined {
  return packages.find(p => p.key === assignments.default) ?? packages.find(p => p.mascot === 'clawd') ?? [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))[0];
}
export function selectPet(participant: Pick<Participant, 'id' | 'platform'> & Partial<Pick<Participant, 'brand'>>, packages: PetPackage[], assignments: Record<string, string>): PetPackage | undefined {
  const scopes = [participant.id, ...(participant.platform ? [`platform:${participant.platform}`] : [])];
  const explicit = [...scopes, 'default'].map(scope => packages.find(p => p.key === assignments[scope])).find(Boolean);
  const brand = participant.brand ?? petBrand(participant.id.startsWith('agent:') ? participant.id.slice(6) : participant.platform ?? '');
  const mascot = brand === 'claude' ? 'clawd' : brand === 'codex' ? 'codex' : undefined;
  return explicit ?? (mascot ? packages.find(p => p.mascot === mascot && p.origin === 'builtin') : undefined) ?? defaultPet(packages, assignments);
}
export const rows = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;
export function atlasFrame(version: 1 | 2, row: number, frame = 0) {
  const r = Math.max(0, Math.min(version === 2 ? 10 : 8, Math.floor(row)));
  return { row: r, frames: rows[r], frame: Math.max(0, Math.min(rows[r] - 1, Math.floor(frame))), height: version === 2 ? 2288 : 1872 };
}

export type PetBrand = 'claude' | 'codex' | 'other';
export interface PetPackage {
  key: string; id: string; name: string; version: 1 | 2; origin: 'arc' | 'codex';
  source: { site: string; pageUrl?: string | null; author?: string | null; license?: string | null; attribution?: string | null; installedAt?: string; sha256?: { petJson: string; spritesheet: string } };
}
export interface Participant { id: string; name: string; brand: PetBrand; kind: 'source' | 'agent'; nativeId: string }
export interface Point { x: number; y: number }
export const recommendations = [
  { brand: 'claude', name: 'Clawd', id: 'clawd--godxxy1229', url: 'https://codexpet.top/pets/clawd--godxxy1229', selected: false },
  { brand: 'claude', name: 'Claude-maiden', id: 'claude-maiden', url: 'https://codex-pets.net/#/pets/claude-maiden', selected: true },
  { brand: 'codex', name: 'GPT Dragon Girl', id: 'gpt-dragon-girl--legeling', url: 'https://codexpet.top/pets/gpt-dragon-girl--legeling', selected: true },
  { brand: 'other', name: 'Maid DeepSeek Whale', id: 'maid-deepseek-whale', url: 'https://codex-pets.net/#/pets/maid-deepseek-whale', selected: true },
] as const;
export function petBrand(product: string): PetBrand {
  if (['claude', 'claude-code', 'claude-desktop', 'claude-web', 'anthropic'].includes(product)) return 'claude';
  if (['codex', 'chatgpt', 'chatgpt-web', 'chatgpt-desktop', 'openai'].includes(product)) return 'codex';
  return 'other';
}
export function selectPet(participant: Participant, packages: PetPackage[], assignments: Record<string, string>): PetPackage | undefined {
  const selected = assignments[participant.id] ?? assignments[`brand:${participant.brand}`];
  if (selected) return packages.find(p => p.key === selected);
  const recommendation = recommendations.find(p => p.brand === participant.brand && p.selected)!;
  return packages.find(p => p.id === recommendation.id);
}
export const rows = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;
export function atlasFrame(version: 1 | 2, row: number, frame = 0) {
  const r = Math.max(0, Math.min(version === 2 ? 10 : 8, Math.floor(row)));
  return { row: r, frames: rows[r], frame: Math.max(0, Math.min(rows[r] - 1, Math.floor(frame))), height: version === 2 ? 2288 : 1872 };
}
export function boundPet(point: Point, width: number, height: number, top = 0): Point {
  return { x: Math.max(0, Math.min(Math.max(0, width - 72), point.x)), y: Math.max(top, Math.min(Math.max(top, height - 78), point.y)) };
}

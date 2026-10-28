import type { PetPackage } from './model';
import { petAssets, petLibrary } from './state';
// Synthetic atlas pixels are generated only by development fixtures. No community art is bundled.
export function installPetFixture() {
  const packages: PetPackage[] = [];
  const assets: Record<string, string> = {};
  for (const [index, id] of ['claude-maiden', 'gpt-dragon-girl--legeling', 'maid-deepseek-whale'].entries()) {
    const version = index === 0 ? 1 : 2;
    const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = version === 1 ? 1872 : 2288;
    const ctx = canvas.getContext('2d')!;
    for (let row = 0; row < (version === 1 ? 9 : 11); row++) for (let frame = 0; frame < 8; frame++) {
      const x = frame * 192, y = row * 208;
      ctx.fillStyle = ['#e88b52', '#8696ed', '#66afa3'][index];
      if (index === 0) ctx.fillRect(x + 44, y + 52 + frame % 3 * 4, 104, 128);
      else { ctx.beginPath(); ctx.ellipse(x + 96, y + 116 + frame % 3 * 3, 52, 64, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#202430'; ctx.fillRect(x + 72, y + 95, 8, 8); ctx.fillRect(x + 110, y + 95, 8, 8);
      if (index !== 0) { ctx.font = '18px sans-serif'; ctx.fillText(`${row}:${frame}`, x + 72, y + 150); }
    }
    const key = `fixture:${id}`;
    assets[key] = canvas.toDataURL('image/png');
    packages.push({ key, id, name: `Synthetic ${index + 1}`, description: 'Animated geometric companion', version, pixelArt: index === 0, origin: index === 2 ? 'codex' : 'arc', source: { site: 'fixture', author: 'ARC fixture', license: 'MIT', attribution: 'Generated geometric placeholder' } });
  }
  petLibrary.set({ packages, errors: [], loading: false, error: '' }); petAssets.set(assets);
  return { packages, errors: [] };
}

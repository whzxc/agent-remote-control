import type { CSSProperties } from 'react';
import { atlasFrame, type PetPackage } from './model';
export default function PetSprite({ pet, url, row = 0, animate = false, slow = false, frame = 0 }: { pet: PetPackage; url: string; row?: number; animate?: boolean; slow?: boolean; frame?: number }) {
  const atlas = atlasFrame(pet.version, row, frame);
  return <span aria-hidden="true" className="pet-sprite" data-animated={animate || undefined} style={{
    backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: `576px ${atlas.height * .375}px`,
    backgroundPosition: `${-atlas.frame * 72}px ${-atlas.row * 78}px`,
    '--pet-end': `${-atlas.frames * 72}px`, '--pet-frames': atlas.frames,
    '--pet-cadence': `${slow && row === 0 ? 4400 : row === 0 ? 1100 : 800}ms`,
  } as CSSProperties} />;
}

import type { CSSProperties } from 'react';
import { petSize, type PetSize } from './geometry';
import { atlasFrame, type PetPackage } from './model';
export default function PetSprite({ pet, url, row = 0, animate = false, slow = false, frame = 0, size = petSize('preview'), tempo = 1, delay = 0 }: { pet: PetPackage; url: string; row?: number; animate?: boolean; slow?: boolean; frame?: number; size?: PetSize; tempo?: number; delay?: number }) {
  const atlas = atlasFrame(pet.version, row, frame);
  return <span aria-hidden="true" className="pet-sprite" data-animated={animate || undefined} style={{
    width: size.width, height: size.height, imageRendering: pet.pixelArt ? 'pixelated' : 'auto',
    backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: `${size.width * 8}px ${atlas.height * size.height / 208}px`,
    backgroundPosition: `${-atlas.frame * size.width}px ${-atlas.row * size.height}px`,
    '--pet-end': `${-atlas.frames * size.width}px`, '--pet-frames': atlas.frames,
    '--pet-cadence': `${(slow && row === 0 ? 4400 : row === 0 ? 1100 : 800) * tempo}ms`, animationDelay: `${delay}ms`,
  } as CSSProperties} />;
}

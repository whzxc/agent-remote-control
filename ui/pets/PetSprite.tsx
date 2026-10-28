import type { CSSProperties } from 'react';
import { petSize, type PetSize } from './geometry';
import { atlasFrame, type PetPackage } from './model';
import type { PetAction } from './behavior';
import { mascotActionForRow, type MascotContact } from './mascotGeometry';
import Mascot from './Mascot';
export default function PetSprite({ pet, url, row = 0, animate = false, slow = false, frame = 0, size = petSize('preview'), tempo = 1, delay = 0, action, contact, facing = row === 2 ? -1 : 1 }: { pet: PetPackage; url: string; row?: number; animate?: boolean; slow?: boolean; frame?: number; size?: PetSize; tempo?: number; delay?: number; action?: PetAction; contact?: MascotContact; facing?: -1 | 1 }) {
  if (pet.mascot) return <Mascot kind={pet.mascot} size={size} animate={animate} slow={slow} tempo={tempo} delay={delay} action={action ?? mascotActionForRow(row)} contact={contact} facing={facing} walking={row === 1 || row === 2} />;
  const atlas = atlasFrame(pet.version, row, frame);
  return <span aria-hidden="true" className="pet-sprite" data-animated={animate || undefined} style={{
    width: size.width, height: size.height, imageRendering: pet.pixelArt ? 'pixelated' : 'auto',
    backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: `${size.width * 8}px ${atlas.height * size.height / 208}px`,
    backgroundPosition: `${-atlas.frame * size.width}px ${-atlas.row * size.height}px`,
    '--pet-end': `${-atlas.frames * size.width}px`, '--pet-frames': atlas.frames,
    '--pet-cadence': `${(slow && row === 0 ? 4400 : row === 0 ? 1100 : 800) * tempo}ms`, animationDelay: `${delay}ms`,
  } as CSSProperties} />;
}

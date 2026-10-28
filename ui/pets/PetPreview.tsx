import { useEffect } from 'react';
import { PawPrint } from 'lucide-react';
import { Icon } from '../components/ui';
import type { PetPackage } from './model';
import { petAsset, petAssets } from './state';
import PetSprite from './PetSprite';
import { usePetMotion } from './usePetMotion';
export default function PetPreview({ pet }: { pet: PetPackage }) {
  const assets = petAssets.use(), motion = usePetMotion();
  useEffect(() => { void petAsset(pet.key).catch(() => {}); }, [pet.key]);
  return <span className="pet-preview" aria-hidden="true">{assets[pet.key]
    ? <PetSprite pet={pet} url={assets[pet.key]} animate={motion.animate} slow />
    : <Icon icon={PawPrint} size={20} />}</span>;
}

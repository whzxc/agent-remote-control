import { useState } from 'react';
import { Popover } from 'radix-ui';
import { PawPrint } from 'lucide-react';
import { t } from '../i18n';
import { Button, IconButton, Notice, SingleChoice } from '../components/ui';
import { assignPet, petAssignments, petLibrary, refreshPets } from './state';
import PetPreview from './PetPreview';
import './pets.css';
export default function PetPicker({ scope, name }: { scope: string; name: string }) {
  const library = petLibrary.use(), assignments = petAssignments.use();
  const [open, setOpen] = useState(false);
  const selected = library.packages.some(p => p.key === assignments[scope]) ? assignments[scope] : '';
  return <Popover.Root open={open} onOpenChange={value => { setOpen(value); if (value) void refreshPets(); }}>
    <Popover.Trigger asChild><IconButton icon={PawPrint} label={t('pets.chooseFor', { name })} /></Popover.Trigger>
    <Popover.Portal><Popover.Content className="pet-picker" side="bottom" align="end" sideOffset={8} collisionPadding={12}
      aria-label={t('pets.chooseFor', { name })} onEscapeKeyDown={event => event.stopPropagation()}>
      {library.error && <Notice tone="danger">{library.error}<Button onClick={() => void refreshPets()}>{t('retry')}</Button></Notice>}
      {!library.packages.length && <p role="status">{t(library.loading ? 'pets.loading' : 'pets.empty')}</p>}
      <SingleChoice cards label={t('pets.chooseFor', { name })} value={selected} onChange={key => { assignPet(scope, key); setOpen(false); }}
        options={[{ value: '', label: t('pets.inherit'), icon: PawPrint }, ...library.packages.map(p => ({ value: p.key, label: p.name, graphic: <PetPreview pet={p} /> }))]} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../../i18n';
import { DialogClose, IconButton } from '../ui';
import { PanelHeader } from '../ui/Panel';

export default function SourcePanelHeader({ brand, title, actions }: { brand: ReactNode; title: string; actions: ReactNode }) {
  return <PanelHeader>
    <header className="dialog-header source-account-header">
      <div className="source-account-brand">{brand}</div>
      <div className="source-account-heading"><h2>{title}</h2></div>
      <div className="actions">{actions}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
  </PanelHeader>;
}

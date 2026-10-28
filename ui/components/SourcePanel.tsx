import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { controlSourcePlatform } from '../controlSources';
import { isLocalSource } from '../sourcePresentation';
import { navigation } from '../state/navigation';
import { ingressPanel, selectSourcePlatform } from '../state/overviewPanels';
import type { ControlSource } from '../state/types';
import { Button, DialogClose, IconButton } from './ui';
import SourceDispatches from './SourceDispatches';
import SourceIcon from './SourceIcon';
export function openSourceWorkspace(id: string) {
  ingressPanel.set(undefined);
  navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: id, remoteConnectionId: undefined }));
}
export default function SourcePanel({ source, widthControl }: { source: ControlSource; widthControl?: ReactNode }) {
  if (isLocalSource(source)) return null;
  const platform = controlSourcePlatform(source.product);
  const label = source.label;
  return <>
    <header className="dialog-header source-account-header">
      <div className="source-account-brand"><Button variant="link" aria-label={platform.displayName} onClick={() => { selectSourcePlatform(platform.id); navigation.set(old => ({ ...old, page: 'overview', remoteSourceId: undefined })); }}><SourceIcon platform={platform.id} /></Button></div>
      <div className="source-account-heading"><h2>{label}</h2></div>
      <div className="actions">{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
    <div className="agent-view-scroll"><SourceDispatches sourceId={source.id} /></div>
  </>;
}

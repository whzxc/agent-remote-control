import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { controlSource } from '../controlSources';
import { isLocalSource } from '../sourcePresentation';
import { name as agentName } from '../state/agents';
import { useAccounts } from '../state/accounts';
import { navigation } from '../state/navigation';
import { ingressPanel, selectSourcePlatform } from '../state/overviewPanels';
import type { ControlSource } from '../state/types';
import { Button, DialogClose, IconButton } from './ui';
import { Sensitive } from './Sensitive';
import SourceDispatches from './SourceDispatches';
import SourceIcon from './SourceIcon';
export function openSourceWorkspace(id: string) {
  ingressPanel.set(undefined);
  navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: id, remoteConnectionId: undefined }));
}
export default function SourcePanel({ source, widthControl }: { source: ControlSource; widthControl?: ReactNode }) {
  const state = useAccounts(), account = state.items.find(a => a.sources.includes(source.id));
  if (isLocalSource(source)) return null;
  const platform = controlSource(source.product)?.displayName ?? agentName({ agent: source.product });
  return <>
    <header className="dialog-header source-account-header">
      <div className="source-account-brand"><Button variant="ghost" aria-label={platform} onClick={() => { selectSourcePlatform(source.product); navigation.set(old => ({ ...old, page: 'overview', remoteSourceId: undefined })); }}><SourceIcon platform={source.product} /></Button></div>
      <div className="source-account-heading"><h2>{platform} · {account?.alias ?? t('accounts.identityUnavailable')}</h2><Sensitive>{account?.email}</Sensitive></div>
      <div className="actions">{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
    <div className="side-panel-scroll source-panel-content"><SourceDispatches sourceId={source.id} /></div>
  </>;
}

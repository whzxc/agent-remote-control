import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { controlSource } from '../controlSources';
import { isLocalSource } from '../sourcePresentation';
import { name as agentName } from '../state/agents';
import { connector, refreshConnector } from '../state/connector';
import { useAccounts } from '../state/accounts';
import { navigation } from '../state/navigation';
import { ingressPanel } from '../state/overviewPanels';
import type { ControlSource } from '../state/types';
import { DialogClose, IconButton, Notice, SingleChoice, Switch } from './ui';
import { Sensitive } from './Sensitive';
import SourceConnection from './SourceConnection';
import SourceDispatches from './SourceDispatches';
import SourceIcon from './SourceIcon';
export function openSourceWorkspace(id: string) {
  ingressPanel.set(undefined);
  navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: id, remoteConnectionId: undefined }));
}
export default function SourcePanel({ source, widthControl }: { source: ControlSource; widthControl?: ReactNode }) {
  const { status } = connector.use(), state = useAccounts();
  const account = state.items.find(a => a.sources.includes(source.id));
  const ingress = status?.ingresses.find(i => i.id === source.ingressId);
  const [tab, setTab] = useState('activity'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (isLocalSource(source)) return null;
  const platform = controlSource(source.product)?.displayName ?? agentName({ agent: source.product });
  return <>
    <header className="dialog-header source-account-header"><div className="source-account-brand"><SourceIcon platform={source.product} /></div>
      <div className="source-account-heading"><h2>{platform} · {account?.alias ?? t('accounts.identityUnavailable')}</h2><Sensitive>{account?.email}</Sensitive></div>
      <div className="actions"><Switch label={t(ingress?.running ? 'disconnect' : 'connect')} checked={!!ingress?.running}
        disabled={!ingress || busy || ['starting', 'stopping'].includes(ingress.state)} onChange={connected => {
          if (!ingress || busy) return;
          setBusy(true); setError('');
          void (async () => {
            try {
              if (connected && !ingress.enabled) await api(`ingress/${ingress.id}`, 'PUT', { enabled: true });
              await api(`ingress/${ingress.id}/${connected ? 'start' : 'stop'}`, 'POST');
            } catch (error) { setError(String(error)); }
            finally {
              await refreshConnector().catch(error => setError(previous => previous || String(error)));
              setBusy(false);
            }
          })();
        }} />{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} disabled={busy} /></DialogClose></div>
    </header>
    <div className="side-panel-scroll source-panel-content">
      {error && <Notice>{error}</Notice>}
      <SingleChoice label={t('accounts.sourceTabs')} value={tab} onChange={setTab} options={['activity', 'connection'].map(value => ({ value, label: t(`accounts.tab.${value}`) }))} />
      {tab === 'activity' && <SourceDispatches sourceId={source.id} />}
      {tab === 'connection' && <SourceConnection source={source} onConnection={id => { ingressPanel.set(undefined); navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: undefined, remoteConnectionId: id })); }} />}
    </div>
  </>;
}

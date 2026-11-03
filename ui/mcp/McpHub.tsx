import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { Button, CopyField, Dialog, Empty, Group, IconButton, Loading, Notice, Row, Status, Switch } from '../components/ui';
import { Sensitive } from '../components/Sensitive';
import type { HubServer, HubSnapshot } from './state';
import './mcp.css';

const tone = (state: HubServer['state']) => state === 'ready' || state === 'idle' ? 'success' : state === 'failed' ? 'danger' : state === 'connecting' ? 'warning' : 'neutral';

function Server({ server, busy, act, remove }: { server: HubServer; busy: string; act: (action: string, server: HubServer) => void; remove: (server: HubServer) => void }) {
  const origin = server.addedBy?.kind === 'import' ? t('mcp.importedFrom', { from: server.addedBy.from ?? '' })
    : server.addedBy?.sourceLabel ? t('mcp.addedBy', { source: server.addedBy.sourceLabel }) : '';
  const facts = [server.transport === 'http' ? 'Streamable HTTP' : 'stdio', server.toolCount !== undefined ? t('mcp.tools', { count: server.toolCount }) : '', origin].filter(Boolean).join(' · ');
  return <div className="mcp-server">
    <Row title={<span className="mcp-server-title"><Sensitive>{server.name}</Sensitive><Status tone={tone(server.state)}>{t(`mcp.state.${server.state}`)}</Status></span>} description={facts}>
      <div className="mcp-server-actions">
        <IconButton icon={RefreshCw} label={t('mcp.check', { name: server.name })} disabled={!!busy || !server.enabled} onClick={() => act('refresh', server)} />
        <IconButton icon={Trash2} label={t('mcp.remove', { name: server.name })} disabled={!!busy} onClick={() => remove(server)} />
        <Switch label={t('mcp.enable', { name: server.name })} checked={server.enabled} disabled={!!busy} onChange={enabled => act(enabled ? 'enable' : 'disable', server)} />
      </div>
    </Row>
    {server.error && <Notice>{server.error}</Notice>}
    {!!server.tools?.length && <details className="mcp-tools"><summary>{t('mcp.toolList')}</summary>
      <ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}</ul>
    </details>}
  </div>;
}

export default function McpHub() {
  locale.use();
  const [snapshot, setSnapshot] = useState<HubSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [removing, setRemoving] = useState<HubServer>();
  const refresh = () => api<HubSnapshot>('mcp-hub').then(setSnapshot, error => setError(String(error)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, []);
  async function act(action: string, server: HubServer) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setBusy(`${action}:${server.name}`); setError('');
    try {
      const result = await api<{ error?: { message?: string } }>('mcp-hub/configure', 'POST', { action, name: server.name });
      if (result?.error?.message) setError(result.error.message);
      await refresh(); setRemoving(undefined);
    } catch (error) { setError(String(error)); }
    finally { setBusy(''); requestAnimationFrame(() => { if (document.activeElement === document.body && trigger?.isConnected) trigger.focus({ preventScroll: true }); }); }
  }
  if (!snapshot) return error ? <Notice action={<Button onClick={() => { setError(''); void refresh(); }}>{t('retry')}</Button>}>{error}</Notice> : <Loading />;
  return <div className="mcp-page">
    {error && <Notice>{error}</Notice>}
    {snapshot.servers.length
      ? <Group>{snapshot.servers.map(server => <Server key={server.name} server={server} busy={busy} act={act} remove={setRemoving} />)}</Group>
      : <Empty action={<CopyField label={t('mcp.prompt')} value={t('mcp.promptText')} />}>{t('mcp.empty')}</Empty>}
    {removing && <Dialog title={t('mcp.remove', { name: removing.name })} onClose={() => setRemoving(undefined)} busy={!!busy} footer={<>
      <Button disabled={!!busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button>
      <Button variant="danger" busy={!!busy} onClick={() => void act('remove', removing)}>{t('delete')}</Button>
    </>}>
      <p>{t('mcp.removeEffect', { name: removing.name })}</p>
    </Dialog>}
  </div>;
}

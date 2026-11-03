import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { Button, Dialog, LoadingIndicator, Notice } from '../components/ui';
import { navigation } from '../state/navigation';
import { trackedActivity } from '../state/activityBubbles';
import { agentPanel, ingressPanel, selectAgentPanel } from '../state/overviewPanels';
import { agentActivity } from '../state/activity';
import { orderedAgents, name } from '../state/agents';
import { connector, ingressState } from '../state/connector';
import { subscriptions } from '../state/subscriptions';
import { useAppNow } from '../state/appEnvironment';
import AgentQuota from '../components/AgentQuota';
import TimelineEntries from '../components/TimelineEntries';
import type { AgentTimeline } from '../types';
import type { TrackedActivity } from '../state/activityModel';
import '../components/TaskDetail.css';

function Conversation({ agent, session }: { agent: string; session: TrackedActivity }) {
  const [timeline, setTimeline] = useState<AgentTimeline>(), [error, setError] = useState('');
  const now = useAppNow();
  useEffect(() => {
    let stopped = false, reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await api<AgentTimeline>('agents/conversations/timeline', 'POST', { agent, id: session.id });
        if (!stopped) { setTimeline(result); setError(''); }
      } catch (error) { if (!stopped) setError(String(error)); }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [agent, session.id]);
  return <>
    <Button variant="ghost" onClick={() => selectAgentPanel({ type: 'back' })}>{t('back')}</Button>
    {error && <Notice>{error}</Notice>}
    {!timeline && !error && <LoadingIndicator label={t("loading")} />}
    {timeline && <div className="timeline-entries"><TimelineEntries entries={timeline.entries} agent={agent} session={session} now={now}
      running={session.endedAt === undefined} status={timeline.status} turnStatuses={timeline.turnStatuses} turnTimings={timeline.turnTimings} /></div>}
    {timeline?.coverage.state === 'partial' && <Notice>{t('browser.partial')}</Notice>}
  </>;
}

export default function BrowserDetails() {
  const selection = agentPanel.use(), source = ingressPanel.use();
  const { status } = connector.use(), { snapshot } = subscriptions.use();
  agentActivity.use();
  const tracked = trackedActivity.use();
  const nav = navigation.use();
  useEffect(() => { if (selection?.closing) agentPanel.set(undefined); }, [selection?.closing]);
  useEffect(() => { if (source?.closing) ingressPanel.set(undefined); }, [source?.closing]);
  if ((!selection || selection.closing) && (!source || source.closing) && !nav.connectionsOpen) return null;
  const agent = selection && orderedAgents().find(a => a.agent === selection.agent);
  const provider = agent && snapshot?.providers.find(p => p.agentIds.includes(agent.agent) && p.eligible);
  const sessions = selection ? tracked[selection.agent] ?? [] : [];
  const connection = source && 'ingress' in source ? status?.ingresses.find(i => i.id === source.ingress.id) : undefined;
  const title = selection ? selection.session?.title || (agent ? name(agent) : selection.agent)
    : connection?.name || (source && 'platform' in source ? source.platform : t('connections.title'));
  return <Dialog title={title} width={860} centered onClose={() => { agentPanel.set(undefined); ingressPanel.set(undefined); navigation.set(old => ({ ...old, connectionsOpen: false })); }}>
    <div className="browser-detail">
      {selection?.session ? <Conversation key={`${selection.agent}:${selection.session.id}`} agent={selection.agent} session={selection.session} /> : selection ? <>
        {agent?.version && <p>{agent.version}</p>}
        {provider && <AgentQuota provider={provider} onRefresh={() => {}} refreshing={false} readOnly />}
        <section aria-label={t('browser.tasks')} className="browser-tasks">
          {sessions.map(session => <Button key={session.id} variant="ghost" onClick={() => selectAgentPanel({ type: 'task', agent: selection.agent, session })}>
            <span>{session.title || session.id}</span><span>{session.headline}</span>
          </Button>)}
          {!sessions.length && <p>{t('browser.noTasks')}</p>}
        </section>
      </> : <section aria-label={t('connections.title')}>
        {(connection ? [connection] : status?.ingresses ?? []).map(ingress => <article key={ingress.id} className="browser-connection">
          <strong>{ingress.name}</strong><span>{t(ingressState(ingress))}</span>
          {ingress.error && <Notice>{ingress.error}</Notice>}
          {ingress.url && <p>{ingress.url}</p>}
        </article>)}
      </section>}
    </div>
  </Dialog>;
}

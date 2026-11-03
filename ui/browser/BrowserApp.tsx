import { useEffect } from 'react';
import { Radio, ShieldCheck } from 'lucide-react';
import ConnectionOverview from '../components/ConnectionOverview';
import { Icon } from '../components/ui';
import { connector, startConnector } from '../state/connector';
import { startAgents } from '../state/agents';
import { startAgentActivity } from '../state/activity';
import { startSubscriptions } from '../state/subscriptions';
import { startTasks } from '../state/tasks';
import { scenarioName } from '../scenarioMode';
import { locale, t } from '../i18n';

export default function BrowserApp() {
  locale.use();
  const { status, error } = connector.use();
  useEffect(() => {
    if (scenarioName) return;
    const stops = [startConnector(), startAgents(), startAgentActivity(), startSubscriptions(), startTasks()];
    return () => stops.forEach(stop => stop());
  }, []);
  return <div className="app-scene browser-scene">
    <header className="browser-header">
      <strong>{status?.deviceName || 'ARC'}</strong>
      <span><Icon icon={ShieldCheck} />{t('browser.readOnly')}</span>
      <span role="status" data-offline={!!error || undefined}><Icon icon={Radio} />{t(error ? 'browser.disconnected' : status ? 'browser.live' : 'loading')}</span>
    </header>
    <main className="home-workspace"><ConnectionOverview /></main>
  </div>;
}

import { useEffect } from 'react';
import ConnectionOverview from '../components/ConnectionOverview';
import Onboarding from '../components/Onboarding';
import { startConnector } from '../state/connector';
import { startAgents } from '../state/agents';
import { startAgentActivity } from '../state/activity';
import { startSubscriptions } from '../state/subscriptions';
import { startTasks } from '../state/tasks';
import { onboarding } from '../state/onboarding';
import { scenarioName } from '../scenarioMode';
import { locale } from '../i18n';

export default function BrowserApp() {
  locale.use();
  const flow = onboarding.use();
  useEffect(() => {
    if (scenarioName) return;
    const stops = [startConnector(), startAgents(), startAgentActivity(), startSubscriptions(), startTasks()];
    return () => stops.forEach(stop => stop());
  }, []);
  return <div className="app-scene">
    <main className="home-workspace"><ConnectionOverview /></main>
    {flow && <Onboarding />}
  </div>;
}

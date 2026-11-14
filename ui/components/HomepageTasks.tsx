import { prepareTaskSnapshot, taskSnapshotElement } from './ui/taskSnapshotMotion';
import { layers, captureLayerTrigger } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { relativeTime } from '../lib/relativeTime';
import { locale, t } from '../i18n';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Inbox, Laptop, ListFilter, Monitor, UserRound, X } from 'lucide-react';
import { BrandMark, Icon, IconButton } from './ui';
import { TaskHistorySummary, TaskSnapshot, taskTitle, type TaskOrigin, type TaskIdentity } from './ui/TaskSnapshot';
import { homepageTaskFocus, remoteTaskPanel } from '../state/homepage';
import { selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import { activeHomepageTask, homepageTaskDay, localTaskDay, previewHomepageTask, recentHomepageTasks, type HomepageTask } from '../state/activityModel';
import { icons, name, orderedAgents } from '../state/agents';
import { useAccounts } from '../state/accounts';
import { orderedSources } from '../state/connector';
import SourceIcon from './SourceIcon';
import { deviceSnapshot, pairedDevices } from '../devices/state';
import { accountOwns } from '../accountPresentation';
import { useAppNow } from '../state/appEnvironment';
import './HomepageTasks.css';

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const focus = homepageTaskFocus.use(), snapshot = deviceSnapshot.use(), { items: accounts } = useAccounts();
  const remote = deviceTasks.use();
  const omitted = Object.values(remote).reduce((sum, item) => sum + (item.snapshot?.omittedRecords ?? 0), 0);
  const body = useRef<HTMLElement>(null);
  const language = locale.use();
  const now = useAppNow(tasks.some(activeHomepageTask) ? 1000 : 60000);
  const today = localTaskDay(now);
  const dates = useMemo(() => {
    const days = new Map<number | undefined, HomepageTask[]>();
    const scoped = tasks.filter(task => {
      if (!focus) return true;
      if (focus.deviceId) return task.deviceId === focus.deviceId && (!focus.agent || task.agent === focus.agent) && (!focus.accountId || task.accountId === focus.accountId);
      if (focus.upstreamSourceId) return task.upstreamSourceId === focus.upstreamSourceId;
      if (focus.sourceIds) return task.sourceIds.some(source => focus.sourceIds!.includes(source)) || task.controllerDeviceId === focus.id.replace(/^device:/, '');
      return !task.deviceId && task.agent === focus.agent && (!focus.accountId || accounts.some(account => account.id === focus.accountId && accountOwns(account, task.accountId)));
    });
    for (const task of scoped.sort(recentHomepageTasks)) {
      const day = homepageTaskDay(task);
      const group = days.get(day);
      if (group) group.push(task);
      else days.set(day, [task]);
    }
    return [...days].sort(([a], [b]) => (b ?? -Infinity) - (a ?? -Infinity));
  }, [tasks, focus, accounts]);
  useLayoutEffect(() => {
    if (!focus) return;
    const target = body.current?.querySelector<HTMLElement>('article');
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    (target?.querySelector<HTMLElement>('[data-task-open]') ?? body.current)?.focus({ preventScroll: true });
  }, [focus?.id]);
  function open(task: HomepageTask) {
    void layers.switchPanel(() => {
      captureLayerTrigger(taskSnapshotElement(task.key)?.querySelector('[data-task-open]') ?? null);
      prepareTaskSnapshot(task.key);
      if (task.group === 'unread') markHomepageTaskRead(task);
      if (task.deviceId) remoteTaskPanel.set({ key: task.key });
      else selectAgentPanel({ type: 'task', agent: task.agent, session: task.session });
    });
  }
  function identity(task: HomepageTask): TaskIdentity {
    const source = orderedSources().find(source => task.sourceIds.includes(source.id));
    const controllerSource = snapshot?.controller && (task.controllerDeviceId === snapshot.controller.deviceId || source?.ingressId === `peer:${snapshot.controller.deviceId}`);
    const recordedSource = task.session.dispatchSummary?.controlSource;
    const agent = orderedAgents().find(agent => agent.agent === task.agent);
    const origin = task.session.origin;
    const label = origin?.sourceLabel || recordedSource?.label || origin?.controlSource || recordedSource?.kind;
    const control: TaskOrigin | undefined = task.deviceId || controllerSource ? {
      label: task.deviceId ? snapshot?.name || label || t('homepage.controller') : snapshot!.controller!.name,
      graphic: <Icon icon={Monitor} size={14} />,
    } : source ? { label: source.label, graphic: <SourceIcon platform={source.product} size={14} /> }
      : label ? { label, graphic: <SourceIcon platform={recordedSource?.kind ?? origin?.controlSource ?? 'custom'} size={14} /> } : undefined;
    return { agent: { label: agent ? name(agent) : name({ agent: task.agent }), graphic: <BrandMark markup={icons[task.agent]} size={20} /> }, source: control };
  }
  function origins(task: HomepageTask, party: TaskIdentity): TaskOrigin[] {
    const account = accounts.find(account => accountOwns(account, task.accountId));
    return [
      ...(party.source ? [party.source] : []),
      ...(task.deviceId ? [{ label: snapshot?.members.find(device => device.deviceId === task.deviceId)?.name ?? task.deviceId, graphic: <Icon icon={Laptop} size={14} /> }] : []),
      { ...party.agent, graphic: <BrandMark markup={icons[task.agent]} size={14} /> },
      ...(account && !task.deviceId ? [{ label: account.alias, graphic: <Icon icon={UserRound} size={14} /> }] : task.accountId ? [{ label: task.accountId, graphic: <Icon icon={UserRound} size={14} /> }] : []),
    ];
  }
  function card(task: HomepageTask, preview: boolean) {
    const freshness = task.freshness ? `${t('device.lastSeen')} ${relativeTime(task.freshness, now, language, t('device.now'))}` : undefined;
    const party = identity(task);
    if (!preview) return <TaskHistorySummary task={task} identity={party} freshness={freshness} now={now} onOpen={() => open(task)} />;
    const device = task.deviceId && pairedDevices(snapshot).find(device => device.id === task.deviceId);
    return <TaskSnapshot task={task} origins={origins(task, party)} now={now}
      path={device && device.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined}
      freshness={freshness} onOpen={() => open(task)} />;
  }
  function grid(items: HomepageTask[], preview: boolean) {
    if (!items.length) return null;
    return <div className="homepage-task-grid" role="list">{items.map(task => <article key={task.key} aria-label={taskTitle(task)}
      className="homepage-task-tile" onClick={event => { if (!(event.target as HTMLElement).closest('button')) open(task); }}>{card(task, preview)}</article>)}</div>;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateLabel = (day?: number) => day === today ? t('agentPanel.today') : day === yesterday.getTime() ? t('agentPanel.yesterday')
    : day === undefined ? t('homepage.unknownDate') : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(day);
  return <main ref={body} className="homepage-tasks" aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <div className="homepage-task-filter" role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></div>}
    {dates.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div>
      : dates.map(([day, items]) => {
        const previews = items.filter(task => previewHomepageTask(task, today));
        const summaries = items.filter(task => !previewHomepageTask(task, today));
        const label = dateLabel(day);
        return <section key={day ?? 'unknown'} className="homepage-task-section" aria-label={label}>
          <h2>{label}</h2>
          {grid(previews, true)}
          {grid(summaries, false)}
        </section>;
      })}
    {omitted > 0 && <p className="homepage-task-omitted" role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

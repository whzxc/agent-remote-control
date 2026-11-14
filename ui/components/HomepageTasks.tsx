import { prepareTaskSnapshot, taskSnapshotElement } from './ui/taskSnapshotMotion';
import { layers, captureLayerTrigger } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { relativeTime } from '../lib/relativeTime';
import { locale } from '../i18n';
import { useLayoutEffect, useRef } from 'react';
import { Inbox, Laptop, ListFilter, Monitor, UserRound, X } from 'lucide-react';
import { BrandMark, Icon, IconButton } from './ui';
import { TaskSnapshot, TaskStatusMark, taskTitle, type TaskOrigin } from './ui/TaskSnapshot';
import TaskStack from './TaskStack';
import { homepageTaskFocus, homepageTaskLayout, homepageTaskFilter, remoteTaskPanel } from '../state/homepage';
import { selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import type { HomepageTask } from '../state/activityModel';
import { icons, name, orderedAgents } from '../state/agents';
import { useAccounts } from '../state/accounts';
import { orderedSources } from '../state/connector';
import SourceIcon from './SourceIcon';
import { deviceSnapshot, pairedDevices } from '../devices/state';
import { accountOwns } from '../accountPresentation';
import { useAppNow } from '../state/appEnvironment';
import { t } from '../i18n';
import './HomepageTasks.css';

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const focus = homepageTaskFocus.use(), snapshot = deviceSnapshot.use(), { items: accounts } = useAccounts();
  const remote = deviceTasks.use();
  const omitted = Object.values(remote).reduce((sum, item) => sum + (item.snapshot?.omittedRecords ?? 0), 0);
  const layout = homepageTaskLayout.use(), filter = homepageTaskFilter.use();
  const body = useRef<HTMLElement>(null);
  const now = useAppNow(tasks.some(task => task.group === 'running' || task.group === 'needs-me') ? 1000 : null);
  const scoped = tasks.filter(task => {
    if (!focus) return true;
    if (focus.deviceId) return task.deviceId === focus.deviceId && (!focus.agent || task.agent === focus.agent) && (!focus.accountId || task.accountId === focus.accountId);
    if (focus.upstreamSourceId) return task.upstreamSourceId === focus.upstreamSourceId;
    if (focus.sourceIds) return task.sourceIds.some(source => focus.sourceIds!.includes(source)) || task.controllerDeviceId === focus.id.replace(/^device:/, '');
    return !task.deviceId && task.agent === focus.agent && (!focus.accountId || accounts.some(account => account.id === focus.accountId && accountOwns(account, task.accountId)));
  });
  useLayoutEffect(() => {
    if (!focus) return;
    const target = body.current?.querySelector<HTMLElement>('article[aria-current="true"]') ?? body.current?.querySelector<HTMLElement>('article');
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    (target?.querySelector<HTMLElement>('.task-snapshot-title') ?? body.current)?.focus({ preventScroll: true });
  }, [focus?.id]);
  const groups = ['needs-me', 'running', 'unread', 'unconfirmed', 'recent'];
  const filtered = scoped.filter(task => filter === 'all' || (filter === 'waiting' ? task.group === 'needs-me'
    : filter === 'completed' ? task.group === 'unread' || task.group === 'recent' : task.group === filter))
    .sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
  function open(task: HomepageTask) {
    void layers.switchPanel(() => {
      captureLayerTrigger(taskSnapshotElement(task.key)?.querySelector('button') ?? null);
      prepareTaskSnapshot(task.key);
      if (task.group === 'unread') markHomepageTaskRead(task);
      if (task.deviceId) remoteTaskPanel.set({ key: task.key });
      else selectAgentPanel({ type: 'task', agent: task.agent, session: task.session });
    });
  }
  function origins(task: HomepageTask): TaskOrigin[] {
    const source = orderedSources().find(source => task.sourceIds.includes(source.id));
    const controllerSource = snapshot?.controller && (task.controllerDeviceId === snapshot.controller.deviceId || source?.ingressId === `peer:${snapshot.controller.deviceId}`);
    const recordedSource = task.session.dispatchSummary?.controlSource;
    const account = accounts.find(account => accountOwns(account, task.accountId));
    const agent = orderedAgents().find(agent => agent.agent === task.agent);
    return [
      ...(task.deviceId ? [{ label: snapshot?.name ?? task.session.origin?.sourceLabel ?? '', graphic: <Icon icon={Monitor} size={14} /> }] : controllerSource && snapshot?.controller ? [{ label: snapshot.controller.name, graphic: <Icon icon={Monitor} size={14} /> }] : source ? [{ label: source.label, graphic: <SourceIcon platform={source.product} /> }] : recordedSource?.label ? [{ label: recordedSource.label, graphic: <SourceIcon platform={recordedSource.kind ?? 'custom'} /> }] : []),
      ...(task.deviceId ? [{ label: snapshot?.members.find(device => device.deviceId === task.deviceId)?.name ?? task.deviceId, graphic: <Icon icon={Laptop} size={14} /> }] : []),
      { label: agent ? name(agent) : task.agent, graphic: <BrandMark markup={icons[task.agent]} size={14} /> },
      ...(account && !task.deviceId ? [{ label: account.alias, graphic: <Icon icon={UserRound} size={14} /> }] : task.accountId ? [{ label: task.accountId, graphic: <Icon icon={UserRound} size={14} /> }] : []),
    ];
  }
  function card(task: HomepageTask, tabbable = true) {
    const device = task.deviceId && pairedDevices(snapshot).find(device => device.id === task.deviceId);
    return <><TaskStatusMark task={task} now={now} /><TaskSnapshot task={task} origins={origins(task)} now={now}
      path={device && device.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined}
      freshness={task.freshness ? `${t('device.lastSeen')} ${relativeTime(task.freshness, now, locale.get(), t('device.now'))}` : undefined}
      tabbable={tabbable} onOpen={() => open(task)} onRead={() => markHomepageTaskRead(task)} /></>;
  }
  return <main ref={body} className="homepage-tasks" data-layout={layout} aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <div className="homepage-task-filter" role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></div>}
    {filtered.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div>
      : layout === 'stack' ? <TaskStack tasks={filtered} render={card} onOpen={open} />
      : <div className="homepage-task-grid" role="list" aria-label={t('homepage.tasks')}>{filtered.map(task => <article key={task.key} aria-label={taskTitle(task)}
        className="homepage-task-tile" onClick={event => { if (!(event.target as HTMLElement).closest('button')) open(task); }}>{card(task)}</article>)}</div>}
    {omitted > 0 && <p role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

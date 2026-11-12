import { layers } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { relativeTime } from '../lib/relativeTime';
import { locale } from '../i18n';
import { useLayoutEffect, useRef, useState } from 'react';
import { Inbox, Laptop, ListFilter, Monitor, UserRound, X } from 'lucide-react';
import { Button, BrandMark, Icon, IconButton } from './ui';
import { TaskCard, type TaskOrigin } from './ui/TaskCard';
import { homepageTaskFocus, remoteTaskPanel } from '../state/homepage';
import { selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import { taskOrder } from '../state/taskOrder';
import type { HomepageTask } from '../state/activityModel';
import { icons, name, orderedAgents } from '../state/agents';
import { useAccounts } from '../state/accounts';
import { orderedSources } from '../state/connector';
import SourceIcon from './SourceIcon';
import { deviceSnapshot, pairedDevices } from '../devices/state';
import { accountOwns } from '../accountPresentation';
import { useMedia } from '../state/hooks';
import { useAppNow } from '../state/appEnvironment';
import { t } from '../i18n';
import './HomepageTasks.css';

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const focus = homepageTaskFocus.use(), snapshot = deviceSnapshot.use(), { items: accounts } = useAccounts();
  const remote = deviceTasks.use();
  const omitted = Object.values(remote).reduce((sum, item) => sum + (item.snapshot?.omittedRecords ?? 0), 0);
  const compact = useMedia('(max-width: 999px)'), wide = useMedia('(min-width: 1500px)');
  const [recent, setRecent] = useState(false);
  const body = useRef<HTMLElement>(null);
  const now = useAppNow(tasks.some(task => task.group === 'running' || task.group === 'needs-me') ? 1000 : null);
  const filtered = tasks.filter(task => {
    if (!focus) return true;
    if (focus.deviceId) return task.deviceId === focus.deviceId && (!focus.agent || task.agent === focus.agent) && (!focus.accountId || task.accountId === focus.accountId);
    if (focus.upstreamSourceId) return task.upstreamSourceId === focus.upstreamSourceId;
    if (focus.sourceIds) return task.sourceIds.some(source => focus.sourceIds!.includes(source)) || task.controllerDeviceId === focus.id.replace(/^device:/, '');
    return !task.deviceId && task.agent === focus.agent && (!focus.accountId || accounts.some(account => account.id === focus.accountId && accountOwns(account, task.accountId)));
  });
  useLayoutEffect(() => {
    if (!focus) return;
    const target = body.current?.querySelector<HTMLElement>('section');
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    (target?.querySelector<HTMLElement>('.task-card-title') ?? body.current)?.focus({ preventScroll: true });
  }, [focus?.id]);
  function move(task: HomepageTask, by: number) {
    const group = tasks.filter(row => row.group === task.group), from = group.indexOf(task), to = from + by;
    if (to < 0 || to >= group.length) return;
    const keys = group.map(row => row.key); keys.splice(from, 1); keys.splice(to, 0, task.key);
    const rest = tasks.map(row => row.key).filter(key => !keys.includes(key));
    taskOrder.set(old => ({ ...old, homepage: [...keys, ...rest] }));
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
  return <main ref={body} className="homepage-tasks" aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <div className="homepage-task-filter" role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></div>}
    {filtered.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div> : <>
      {(['needs-me', 'running', 'unread', 'unconfirmed', 'recent'] as const).map(group => {
        const items = filtered.filter(task => task.group === group);
        if (!items.length) return null;
        return <section key={group} aria-label={t(`homepage.${group}`)} data-group={group} data-focused={!!focus || undefined}>
          {group === 'recent' ? <Button variant="ghost" aria-expanded={recent} onClick={() => setRecent(!recent)}>{t('homepage.recent')} · {items.length}</Button>
            : <h2>{t(`homepage.${group}`)}<span>{items.length}</span></h2>}
          {(group !== 'recent' || recent) && <div className="homepage-task-grid" data-small={items.length < 3 || undefined}>{items.map(task => <TaskCard key={task.key} task={task} origins={origins(task)}
            density={compact ? 'compact' : wide ? 'wide' : 'standard'} now={now}
            path={task.deviceId ? (() => { const device = pairedDevices(snapshot).find(device => device.id === task.deviceId); return device?.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined; })() : undefined}
            freshness={task.freshness ? `${t('device.lastSeen')} ${relativeTime(task.freshness, now, locale.get(), t('device.now'))}` : undefined}
            onOpen={() => layers.switchPanel(() => { if (task.group === 'unread') markHomepageTaskRead(task); if (task.deviceId) remoteTaskPanel.set({ key: task.key }); else selectAgentPanel({ type: 'task', agent: task.agent, session: task.session }); })}
            onRead={() => markHomepageTaskRead(task)}
            onMove={group === 'needs-me' || group === 'running' ? by => move(task, by) : undefined} />)}</div>}
        </section>;
      })}
    </>}
    {omitted > 0 && <p className="task-card-meta" role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

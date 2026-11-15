import { TaskFilter, TaskFeedSection } from './timeline/TimelineSurface';
import { taskSnapshotElement } from './timeline/taskSnapshotMotion';
import { prepareTaskSnapshot } from "./timeline/taskSnapshotMotion";
import { layers, captureLayerTrigger } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { locale, t } from '../i18n';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Inbox, ListFilter, X } from 'lucide-react';
import { Icon, IconButton } from './ui';
import { TaskCard } from './ui/TaskCard';
import { homepageTaskFocus, remoteTaskPanel } from '../state/homepage';
import { selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import { activeHomepageTask, homepageTaskDay, localTaskDay, previewHomepageTask, recentHomepageTasks, type HomepageTask } from '../state/activityModel';
import { useAccounts } from '../state/accounts';
import { accountOwns } from '../accountPresentation';
import { useAppNow } from '../state/appEnvironment';
import './HomepageTasks.css';

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const focus = homepageTaskFocus.use(), { items: accounts } = useAccounts();
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
    const target = body.current?.querySelector<HTMLElement>('[data-task-snapshot]');
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
  function grid(items: HomepageTask[], preview: boolean) {
    if (!items.length) return null;
    return <div className="homepage-task-grid" role="list">{items.map(task => <TaskCard key={task.key} task={task}
      form={preview ? 'detail' : 'summary'} now={now} snapshotKey={task.key} onOpen={() => open(task)} />)}</div>;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateLabel = (day?: number) => day === today ? t('agentPanel.today') : day === yesterday.getTime() ? t('agentPanel.yesterday')
    : day === undefined ? t('homepage.unknownDate') : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(day);
  return <main ref={body} className="homepage-tasks" aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <TaskFilter  role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></TaskFilter>}
    {dates.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div>
      : dates.map(([day, items]) => {
        const previews = items.filter(task => previewHomepageTask(task, today));
        const summaries = items.filter(task => !previewHomepageTask(task, today));
        const label = dateLabel(day);
        return <TaskFeedSection key={day ?? 'unknown'}  aria-label={label}>
          <h2>{label}</h2>
          {grid(previews, true)}
          {grid(summaries, false)}
        </TaskFeedSection>;
      })}
    {omitted > 0 && <p className="homepage-task-omitted" role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

import { TaskFilter, TaskFeedSection } from './timeline/TimelineSurface';
import { taskSnapshotElement } from './timeline/taskSnapshotMotion';
import { prepareTaskSnapshot } from "./timeline/taskSnapshotMotion";
import { layers, captureLayerTrigger } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { locale, t } from '../i18n';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, GitFork, Inbox, ListFilter, X } from 'lucide-react';
import { Button, Icon, IconButton, Panel } from './ui';
import { TaskCard, taskTitle } from './ui/TaskCard';
import { homepageTaskFocus, remoteTaskPanel } from '../state/homepage';
import { panelBack, selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import { activeHomepageTask, homepageTaskFamilies, localTaskDay, previewHomepageTask, type TaskFamily, type HomepageTask } from '../state/activityModel';
import { useAccounts } from '../state/accounts';
import { accountOwns } from '../accountPresentation';
import { useAppNow } from '../state/appEnvironment';
import { presentTaskState, taskException } from '../state/taskProjection';
import { useTaskPreview } from '../state/taskExecution';
import { PanelRoute } from './ui/Panel';
import './HomepageTasks.css';

function ChildTaskRow({ task, onOpen }: { task: HomepageTask; onOpen: () => void }) {
  const row = useRef<HTMLButtonElement>(null);
  useTaskPreview(task.agent, task.session.id, !task.deviceId && task.session.timeline, row, !activeHomepageTask(task), task.session.turnId);
  const state = presentTaskState(task.session.status ?? undefined, activeHomepageTask(task), task.group === 'needs-me');
  const title = taskTitle(task);
  const assignment = task.session.fallbackHeadline || title;
  const activity = task.session.interaction?.summary || task.activity.snapshot.at(-1)?.text || task.session.headline;
  return <button ref={row} type="button" className="task-card task-child-row" id={`subagent-${task.key}`} data-child={task.key}
    data-aurora={state === 'running' ? task.session.phase : undefined}
    style={{ '--task-aurora-ink': `var(--phase-${task.session.phase}, var(--role-agent))` } as CSSProperties}
    aria-description={t(`detail.state.${state}`)} onClick={onOpen}>
    <span className="task-child-heading"><strong>{assignment}</strong>{state !== 'running' && <span>{t(`detail.state.${state}`)}</span>}<Icon icon={ChevronRight} size={14} /></span>
    <span className="task-child-description">{[assignment !== title ? title : undefined, activity !== assignment ? activity : undefined].filter(Boolean).join(' · ')}</span>
  </button>;
}

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const [familyKey, setFamilyKey] = useState<string>();
  const [returnChild, setReturnChild] = useState<string>();
  const focus = homepageTaskFocus.use(), { items: accounts } = useAccounts();
  const remote = deviceTasks.use();
  const omitted = Object.values(remote).reduce((sum, item) => sum + (item.snapshot?.omittedRecords ?? 0), 0);
  const body = useRef<HTMLElement>(null);
  const language = locale.use();
  const now = useAppNow(tasks.some(activeHomepageTask) ? 1000 : 60000);
  const today = localTaskDay(now);
  const dates = useMemo(() => {
    const days = new Map<number | undefined, TaskFamily[]>();
    const scoped = tasks.filter(task => {
      if (!focus) return true;
      if (focus.deviceId) return task.deviceId === focus.deviceId && (!focus.agent || task.agent === focus.agent) && (!focus.accountId || task.accountId === focus.accountId);
      if (focus.upstreamSourceId) return task.upstreamSourceId === focus.upstreamSourceId;
      if (focus.sourceIds) return task.sourceIds.some(source => focus.sourceIds!.includes(source)) || task.controllerDeviceId === focus.id.replace(/^device:/, '');
      return !task.deviceId && task.agent === focus.agent && (!focus.accountId || accounts.some(account => account.id === focus.accountId && accountOwns(account, task.accountId)));
    });
    for (const task of homepageTaskFamilies(scoped)) {
      const day = task.latest ? localTaskDay(task.latest) : undefined;
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
  const family = dates.flatMap(([, items]) => items).find(item => item.parent.key === familyKey);
  function open(task: HomepageTask, from?: TaskFamily) {
    void layers.switchPanel(() => {
      captureLayerTrigger(taskSnapshotElement(from?.parent.key ?? task.key)?.querySelector(from ? '[data-children]' : '[data-task-open]') ?? null);
      const back = from ? () => { setReturnChild(task.key); setFamilyKey(from.parent.key); } : undefined;
      if (from) setFamilyKey(undefined);
      if (back && !task.deviceId) panelBack.set({ label: t('homepage.subagents'), open: back });
      prepareTaskSnapshot(task.key);
      if (task.group === 'unread') markHomepageTaskRead(task);
      if (task.deviceId) remoteTaskPanel.set({ key: task.key, back });
      else selectAgentPanel({ type: 'task', agent: task.agent, session: task.session });
    });
  }
  function grid(items: TaskFamily[], preview: boolean) {
    if (!items.length) return null;
    return <div className="homepage-task-grid" role="list">{items.map(({ parent: task, children }) => {
      const attention = children.filter(child => child.group === 'needs-me').length;
      const failed = children.filter(child => taskException(child.session.status) === 'failed').length;
      return <TaskCard key={task.key} task={task} grid form={preview ? 'detail' : 'summary'} now={now} snapshotKey={task.key} onOpen={() => open(task)}
        footer={children.length > 0 && <div className="task-card-footer"><Button variant="link" className="task-child-trigger" data-children onClick={event => {
          captureLayerTrigger(event.currentTarget); setReturnChild(undefined); layers.switchPanel(() => setFamilyKey(task.key));
        }}><Icon icon={GitFork} size={14} />{t('homepage.childCount', { count: children.length })}
        {attention > 0 && <span>{t('homepage.childAttention', { count: attention })}</span>}
        {failed > 0 && <span>{t('homepage.childFailures', { count: failed })}</span>}<Icon icon={ChevronRight} size={14} /></Button></div>} />;
    })}</div>;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateLabel = (day?: number) => day === today ? t('agentPanel.today') : day === yesterday.getTime() ? t('agentPanel.yesterday')
    : day === undefined ? t('homepage.unknownDate') : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(day);
  return <main ref={body} className="homepage-tasks" aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <TaskFilter  role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></TaskFilter>}
    {dates.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div>
      : dates.map(([day, items]) => {
        const previews = items.filter(family => day === today || [family.parent, ...family.children].some(task => previewHomepageTask(task, today)));
        const summaries = items.filter(family => !previews.includes(family));
        const label = dateLabel(day);
        return <TaskFeedSection key={day ?? 'unknown'}  aria-label={label}>
          <h2>{label}</h2>
          {grid(previews, true)}
          {grid(summaries, false)}
        </TaskFeedSection>;
      })}
    <PanelRoute value={family} identity={item => item.parent.key}>{family => <Panel size="m" title={t('homepage.subagents')} description={taskTitle(family.parent)}
      returnFocus={`[data-task-snapshot="${CSS.escape(family.parent.key)}"] [data-children]`}
      initialFocus={returnChild ? `subagent-${returnChild}` : undefined}
      onClose={() => setFamilyKey(undefined)}>
      <div className="homepage-child-list">{family.children.map(child => <ChildTaskRow task={child} key={child.key} onOpen={() => open(child, family)} />)}</div>
    </Panel>}</PanelRoute>
    {omitted > 0 && <p className="homepage-task-omitted" role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

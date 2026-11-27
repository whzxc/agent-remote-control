import { TaskFilter, TaskFeedSection } from './timeline/TimelineSurface';
import { taskSnapshotElement } from './timeline/taskSnapshotElement';
import { layers } from '../state/layers';
import { deviceTasks } from '../devices/tasks';
import { locale, t } from '../i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, GitFork, Inbox, ListFilter, X } from 'lucide-react';
import { BrandMark, Icon, IconButton, Panel } from './ui';
import { formatTaskCardTime, TaskCard, taskTitle } from './ui/TaskCard';
import { homepageTaskFocus, remoteTaskPanel } from '../state/homepage';
import { panelBack, selectAgentPanel } from '../state/overviewPanels';
import { markHomepageTaskRead } from '../state/homepageTasks';
import { activeHomepageTask, homepageTaskFamilies, localTaskDay, type TaskFamily, type HomepageTask } from '../state/activityModel';
import { useAppNow } from '../state/appEnvironment';
import { icons } from '../state/agents';
import { taskException } from '../state/taskProjection';
import './HomepageTasks.css';

function TaskDayGrid({ items, preview, now, open, openChildren }: {
  items: TaskFamily[]; preview: boolean; now: number;
  open: (task: HomepageTask) => void; openChildren: (key: string, trigger: HTMLButtonElement) => void;
}) {
  const grid = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<string | null | undefined>(undefined);
  const [columns, setColumns] = useState(1);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const node = grid.current!;
    const measure = () => setColumns(getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const key = focusAfterToggle.current;
    if (key === undefined) return;
    focusAfterToggle.current = undefined;
    const target = key ? taskSnapshotElement(key)?.querySelector<HTMLElement>('[data-task-open]') : toggle.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);

  const limit = columns * 2;
  const shown = items.length > limit ? limit - 1 : items.length;
  const overflow = items.length - shown;
  const visible = expanded ? items : items.slice(0, shown);
  const language = locale.use();
  const label = t(expanded ? 'homepage.collapseTasks' : 'homepage.expandTasks', { count: overflow });
  const hiddenItems = items.slice(shown, shown + (preview ? 4 : 2));
  const more = overflow - hiddenItems.length;
  const form = preview ? 'detail' : 'summary';
  return <div ref={grid} className="homepage-task-grid" role="list">
    {visible.map(({ parent: task, children }) => {
      const attention = children.filter(child => child.group === 'needs-me').length;
      const failed = children.filter(child => taskException(child.session.status) === 'failed').length;
      return <TaskCard key={task.key} task={task} form={form} now={now} attention={attention > 0} snapshotKey={task.key} onOpen={() => open(task)}
        metaAction={preview && children.length > 0 && <button type="button" className="task-child-pill" data-children
          data-tone={attention > 0 ? 'warning' : failed > 0 ? 'danger' : undefined}
          aria-label={[t('homepage.childCount', { count: children.length }),
            attention > 0 ? t('homepage.childAttention', { count: attention }) : '',
            failed > 0 ? t('homepage.childFailures', { count: failed }) : ''].filter(Boolean).join(' · ')}
          onClick={event => { event.stopPropagation(); openChildren(task.key, event.currentTarget); }}>
          <Icon icon={GitFork} size={11} />
          <span>{children.length}{(attention || failed) > 0 && ` · ${attention || failed}`}</span>
          <Icon icon={ChevronRight} size={11} />
        </button>} />;
    })}
    {overflow > 0 && <button ref={toggle} type="button" className="homepage-task-overflow" data-form={form} aria-expanded={expanded} aria-label={label} onClick={() => {
      focusAfterToggle.current = expanded ? null : items[shown].parent.key;
      setExpanded(!expanded);
    }}><span className="homepage-task-overflow-face">
      <span className="homepage-task-overflow-heading">
        <strong>{label}</strong>
        <Icon icon={expanded ? ChevronUp : ChevronDown} size={16} />
      </span>
      {expanded ? <span className="homepage-task-overflow-caption" aria-hidden="true">{t('homepage.totalTasks', { count: items.length })}</span>
        : <span className="homepage-task-overflow-peek" aria-hidden="true">
          <span className="homepage-task-overflow-rows">
            {hiddenItems.map(({ parent }) => {
              const time = formatTaskCardTime(parent, now, language);
              return <span className="homepage-task-overflow-row" key={parent.key}>
                <BrandMark markup={icons[parent.agent]} size={12} />
                <span className="homepage-task-overflow-title">{taskTitle(parent)}</span>
                {time && <time className="homepage-task-overflow-caption" dateTime={time.dateTime} title={time.title}>{time.label}</time>}
              </span>;
            })}
          </span>
          {preview && more > 0 && <span className="homepage-task-overflow-caption">{t('homepage.moreTasks', { count: more })}</span>}
        </span>}
    </span></button>}
  </div>;
}

export default function HomepageTasks({ tasks }: { tasks: HomepageTask[] }) {
  const [familyKey, setFamilyKey] = useState<string>();
  const [returnChild, setReturnChild] = useState<string>();
  const focus = homepageTaskFocus.use();
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
      if (focus.deviceId) return task.deviceId === focus.deviceId && (!focus.agent || task.agent === focus.agent);
      if (focus.upstreamSourceId) return task.upstreamSourceId === focus.upstreamSourceId;
      if (focus.sourceIds) return task.sourceIds.some(source => focus.sourceIds!.includes(source)) || task.controllerDeviceId === focus.id.replace(/^device:/, '');
      return !task.deviceId && task.agent === focus.agent;
    });
    for (const task of homepageTaskFamilies(scoped)) {
      const day = task.latest ? localTaskDay(task.latest) : undefined;
      const group = days.get(day);
      if (group) group.push(task);
      else days.set(day, [task]);
    }
    return [...days].sort(([a], [b]) => (b ?? -Infinity) - (a ?? -Infinity));
  }, [tasks, focus]);
  useLayoutEffect(() => {
    if (!focus) return;
    const target = body.current?.querySelector<HTMLElement>('[data-task-snapshot]');
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    (target?.querySelector<HTMLElement>('[data-task-open]') ?? body.current)?.focus({ preventScroll: true });
  }, [focus?.id]);
  const family = dates.flatMap(([, items]) => items).find(item => item.parent.key === familyKey);
  function open(task: HomepageTask, from?: TaskFamily) {
    void layers.switchPanel(() => {
      const back = from ? () => { setReturnChild(task.key); setFamilyKey(from.parent.key); } : undefined;
      if (from) setFamilyKey(undefined);
      if (back && !task.deviceId) panelBack.set({ label: t('homepage.subagents'), open: back });
      if (task.group === 'unread') markHomepageTaskRead(task);
      if (task.deviceId) remoteTaskPanel.set({ key: task.key, back });
      else selectAgentPanel({ type: 'task', agent: task.agent, session: task.session });
    });
  }
  function openChildren(key: string, trigger: HTMLButtonElement) {
    trigger.focus({ preventScroll: true });
    setReturnChild(undefined);
    void layers.switchPanel(() => setFamilyKey(key));
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateLabel = (day?: number) => day === today ? t('agentPanel.today') : day === yesterday.getTime() ? t('agentPanel.yesterday')
    : day === undefined ? t('homepage.unknownDate') : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(day);
  return <main ref={body} className="homepage-tasks" aria-label={t('homepage.tasks')} tabIndex={-1}>
    {focus && <TaskFilter  role="status"><Icon icon={ListFilter} size={14} />{focus.label}<IconButton compact icon={X} label={t('homepage.clearFilter')} onClick={() => homepageTaskFocus.set(undefined)} /></TaskFilter>}
    {dates.length === 0 ? <div className="homepage-tasks-empty"><Icon icon={Inbox} size={32} /><h2>{t('homepage.empty')}</h2></div>
      : dates.map(([day, items]) => {
        const label = dateLabel(day);
        return <TaskFeedSection key={day ?? 'unknown'}  aria-label={label}>
          <h2>{label}</h2>
          <TaskDayGrid items={items} preview={day === today} now={now} open={open} openChildren={openChildren} />
        </TaskFeedSection>;
      })}
    {family && <Panel key={family.parent.key} size="m" className="task-family-panel" title={taskTitle(family.parent)}
      returnFocus={`[data-task-snapshot="${CSS.escape(family.parent.key)}"] [data-children]`}
      initialFocus={returnChild ? `subagent-${returnChild}` : undefined}
      onClose={() => setFamilyKey(undefined)}>
      <div className="homepage-child-list">{family.children.map(child => {
        const title = taskTitle(child), assignment = child.session.fallbackHeadline;
        const task = assignment && assignment !== title
          ? { ...child, session: { ...child.session, title: `${title} · ${assignment}` } } : child;
        return <TaskCard form="summary" task={task} now={now} key={child.key}
          trigger={{ id: `subagent-${child.key}` }} onOpen={() => open(child, family)} />;
      })}</div>
    </Panel>}
    {omitted > 0 && <p className="homepage-task-omitted" role="status" aria-label={t('homepage.partial')}>{t('homepage.omitted', { count: omitted })}</p>}
  </main>;
}

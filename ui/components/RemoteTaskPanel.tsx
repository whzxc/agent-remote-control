import { useEffect } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { IconButton, Notice, Panel } from './ui';
import { PanelHeader } from './ui/Panel';
import { TaskCard, taskTitle } from './ui/TaskCard';
import { useAppNow } from '../state/appEnvironment';
import { remoteTaskPanel } from '../state/homepage';
import type { HomepageTask } from '../state/activityModel';
import { t } from '../i18n';

export default function RemoteTaskPanel({ tasks }: { tasks: HomepageTask[] }) {
  const selected = remoteTaskPanel.use();
  const task = selected && tasks.find(task => task.key === selected.key);
  const now = useAppNow(task?.group === 'running' ? 1000 : 60000);
  useEffect(() => { if (selected && !task) remoteTaskPanel.set(undefined); }, [selected, task]);
  if (!task) return null;
  const close = () => remoteTaskPanel.set(undefined);
  return <Panel headerless snapshotKey={task.key} returnFocus={`[data-task-snapshot="${CSS.escape(task.key)}"] [data-task-open]`} size="m" title={taskTitle(task)} onClose={close}>
    <PanelHeader><div className="actions">{selected?.back && <IconButton icon={ArrowLeft} label={t('back')} onClick={() => { close(); selected.back?.(); }} />}<IconButton icon={X} label={t('close')} onClick={close} /></div></PanelHeader>
    <TaskCard task={task} form="detail" now={now} />
    <Notice layout="inline">{t('homepage.remoteDetailLimit')}</Notice>
  </Panel>;
}

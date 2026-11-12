import { useEffect } from 'react';
import { Laptop } from 'lucide-react';
import { deviceSnapshot } from '../devices/state';
import { icons } from '../state/agents';
import { Notice, Panel, Icon, BrandMark } from './ui';
import { TaskCard } from './ui/TaskCard';
import { remoteTaskPanel } from '../state/homepage';
import { markHomepageTaskRead } from '../state/homepageTasks';
import type { HomepageTask } from '../state/activityModel';
import { t } from '../i18n';

export default function RemoteTaskPanel({ tasks }: { tasks: HomepageTask[] }) {
  const selected = remoteTaskPanel.use();
  const task = selected && tasks.find(task => task.key === selected.key);
  const snapshot = deviceSnapshot.use();
  useEffect(() => { if (selected && !task) remoteTaskPanel.set(undefined); }, [selected, task]);
  if (!task) return null;
  return <Panel side="right" title={task.session.title || task.session.id} onClose={() => remoteTaskPanel.set(undefined)}>
    <TaskCard task={task} origins={[{ label: snapshot?.members.find(member => member.deviceId === task.deviceId)?.name ?? task.deviceId!, graphic: <Icon icon={Laptop} size={14} /> }, { label: task.agent, graphic: <BrandMark markup={icons[task.agent]} size={14} /> }]} density="wide" now={Date.now()} freshness={task.freshness}
      onRead={() => markHomepageTaskRead(task)} />
    {task.session.interaction && <p className="task-card-activity">{task.session.interaction.summary}</p>}
    <Notice layout="inline">{t('homepage.remoteDetailLimit')}</Notice>
  </Panel>;
}

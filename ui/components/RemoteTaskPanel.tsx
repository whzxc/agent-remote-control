import { useEffect } from 'react';
import { Laptop } from 'lucide-react';
import { deviceSnapshot } from '../devices/state';
import { icons } from '../state/agents';
import { Notice, Panel, Icon, BrandMark } from './ui';
import { TaskSnapshot } from './ui/TaskSnapshot';
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
  return <Panel snapshotKey={task.key} returnFocus={`[data-task-snapshot="${CSS.escape(task.key)}"] .task-snapshot-title`} size="m" title={task.session.title || task.session.id} onClose={() => remoteTaskPanel.set(undefined)}>
    <TaskSnapshot task={{ ...task, key: `detail:${task.key}` }} origins={[{ label: snapshot?.members.find(member => member.deviceId === task.deviceId)?.name ?? task.deviceId!, graphic: <Icon icon={Laptop} size={14} /> }, { label: task.agent, graphic: <BrandMark markup={icons[task.agent]} size={14} /> }]} now={Date.now()} freshness={task.freshness}
      onRead={() => markHomepageTaskRead(task)} />
    {task.session.interaction && <p>{task.session.interaction.summary}</p>}
    <Notice layout="inline">{t('homepage.remoteDetailLimit')}</Notice>
  </Panel>;
}

import { GalleryHorizontalEnd, LayoutGrid } from 'lucide-react';
import { SingleChoice } from './ui';
import { homepageTaskLayout, homepageTaskFilter, type TaskFilter, type TaskLayout } from '../state/homepage';
import type { HomepageTask } from '../state/activityModel';
import { useMedia } from '../state/hooks';
import { t } from '../i18n';
export default function TaskViewControls({ tasks }: { tasks: HomepageTask[] }) {
  const layout = homepageTaskLayout.use(), filter = homepageTaskFilter.use(), mobile = useMedia('(max-width: 499px)');
  return <div className="task-view-controls">
    {!mobile && <SingleChoice label={t('homepage.filter')} value={filter} dropdown compact onChange={value => homepageTaskFilter.set(value as TaskFilter)}
      options={(['all', 'running', 'waiting', 'completed', 'unconfirmed'] as const).map(value => ({ value,
        label: `${t(`homepage.filter.${value}`)} ${tasks.filter(task => value === 'all' || (value === 'waiting' ? task.group === 'needs-me' : value === 'completed' ? task.group === 'unread' || task.group === 'recent' : task.group === value)).length}` }))} />}
    <SingleChoice label={t('homepage.layout')} value={layout} iconOnly compact onChange={value => homepageTaskLayout.set(value as TaskLayout)} options={[
      { value: 'tile', label: t('homepage.tile'), icon: LayoutGrid }, { value: 'stack', label: t('homepage.stack'), icon: GalleryHorizontalEnd },
    ]} />
  </div>;
}

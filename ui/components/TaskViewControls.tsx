import { GalleryHorizontalEnd, LayoutGrid } from 'lucide-react';
import { SingleChoice } from './ui';
import { homepageTaskLayout, type TaskLayout } from '../state/homepage';
import { t } from '../i18n';
export default function TaskViewControls() {
  const layout = homepageTaskLayout.use();
  return <div className="task-view-controls">
    <SingleChoice label={t('homepage.layout')} value={layout} iconOnly compact onChange={value => homepageTaskLayout.set(value as TaskLayout)} options={[
      { value: 'tile', label: t('homepage.tile'), icon: LayoutGrid }, { value: 'stack', label: t('homepage.stack'), icon: GalleryHorizontalEnd },
    ]} />
  </div>;
}

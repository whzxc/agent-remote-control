import { Button, SingleChoice } from './index';
import { t } from '../../i18n';
import './HomepageBar.css';

export function HomepageBarView({ dateTime, time, day, weekday, summary, mode, onOpenBoard, onModeChange }: {
  dateTime: string; time: string; day: string; weekday: string; summary: string;
  mode: 'topology' | 'tasks'; onOpenBoard: () => void; onModeChange: (value: string) => void;
}) {
  return <header className="homepage-bar">
    <div className="homepage-bar-board">
      <time dateTime={dateTime} aria-label={t('studio.clock')}>{time}</time>
      <Button id="board-trigger" variant="ghost" aria-label={t('center.open')} aria-description={summary || undefined}
        aria-haspopup="dialog" onClick={onOpenBoard}>{t('center.title')}<span className="homepage-bar-date"> · {day} · {weekday}</span></Button>
    </div>
    <div className="homepage-mode-switch"><SingleChoice label={t('homepage.mode')} value={mode} compact onChange={onModeChange}
      options={[{ value: 'topology', label: t('homepage.topology') }, { value: 'tasks', label: t('homepage.tasks') }]} /></div>
  </header>;
}

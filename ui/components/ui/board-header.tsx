import { Button } from './index';
import './board-header.css';

export function BoardHeader({ date, time, dateTime, clockLabel, title, activityLabel, summary, openLabel, onOpen }: {
  date: string;
  time: string;
  dateTime: string;
  clockLabel: string;
  title: string;
  activityLabel: string;
  summary: string;
  openLabel: string;
  onOpen: () => void;
}) {
  return <header className="board-header">
    <span className="board-header-date">{date}</span>
    <time className="board-header-time" dateTime={dateTime} title={clockLabel}>{time}</time>
    <div className="board-header-activity" role="status" aria-label={activityLabel} aria-live="polite" aria-atomic="true">
      <Button id="board-trigger" variant="ghost" className="board-header-trigger" aria-label={openLabel}
        aria-description={summary || undefined} aria-haspopup="dialog" onClick={onOpen}>
        {summary || title}
      </Button>
    </div>
  </header>;
}

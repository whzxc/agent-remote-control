import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Icon } from './index';
import './TaskRow.css';

export function TaskBubble({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type="button" className={className ? `activity-bubble ${className}` : 'activity-bubble'} />;
}

export function TaskBubbleCopy({ title, titleEnd, children }: { title: string; titleEnd?: ReactNode; children: ReactNode }) {
  return <span className="activity-copy">
    <span className="activity-title-row"><strong>{title}</strong>{titleEnd}</span>
    {children}
  </span>;
}

/** Task rows from design/modules/task-presentation.tsx. */
export function TaskRow({ title, meta, tile, tone, attention = false, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  title: string; meta: ReactNode; tile: ReactNode; tone: string; attention?: boolean;
}) {
  return <button type="button" {...props} disabled={disabled} className="task-row" data-attention={attention || undefined} style={{ '--task-row-tone': `var(--${tone})` } as CSSProperties}>
    {tile}<span className="task-row-copy"><strong>{title}</strong><span className="task-row-meta">{meta}</span></span>
    {!disabled && <Icon icon={ChevronRight} />}
  </button>;
}

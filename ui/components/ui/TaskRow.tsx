import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Icon } from './index';
import './TaskRow.css';

/** Task rows from design/modules/task-presentation.tsx. */
export function TaskRow({ title, meta, tile, tone, attention = false, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  title: string; meta: ReactNode; tile: ReactNode; tone: string; attention?: boolean;
}) {
  return <button type="button" {...props} disabled={disabled} className="task-row" data-attention={attention || undefined} style={{ '--task-row-tone': `var(--${tone})` } as CSSProperties}>
    {tile}<span className="task-row-copy"><strong>{title}</strong><span className="task-row-meta">{meta}</span></span>
    {!disabled && <Icon icon={ChevronRight} />}
  </button>;
}

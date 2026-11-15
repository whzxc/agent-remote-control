import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Card } from './card';
import './Record.css';

export function RecordCard({ children }: { children: ReactNode }) {
  return <Card className="record-row">{children}</Card>;
}
export function RecordRow({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Card asChild className={`record-row ${className}`}><button type="button" {...props}>{children}</button></Card>;
}
export function RecordMeta({ as: Element = 'span', className = '', ...props }: HTMLAttributes<HTMLElement> & { as?: 'span' | 'div' }) {
  return <Element {...props} className={`record-row-meta ${className}`} />;
}
export function RecordHeading({ count, children, attention, note }: { count?: number; children: ReactNode; attention?: boolean; note?: ReactNode }) {
  return <h2 className="record-heading" data-attention={attention || undefined}>{children}{count !== undefined && count > 0 && <span className="record-count">{count}</span>}{note && <span role="status" className="record-note">· {note}</span>}</h2>;
}

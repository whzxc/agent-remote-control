import type { HTMLAttributes } from 'react';
import './UpdateContent.css';

const variants = {"about": "settings-about", "notes": "update-note-group", "body": "update-panel-body"} as const;
type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li'; variant: keyof typeof variants };

export function UpdateContent({ as: Element = 'div', variant, className = '', ...props }: Props) {
  return <Element {...props} className={`${variants[variant]} ${className}`} />;
}

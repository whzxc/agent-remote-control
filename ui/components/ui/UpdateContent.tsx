import type { HTMLAttributes } from 'react';
import './UpdateContent.css';

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' };

export function UpdateContent({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}

import type { HTMLAttributes } from 'react';
import './ServiceInventory.css';

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' };

export function ServiceInventory({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}

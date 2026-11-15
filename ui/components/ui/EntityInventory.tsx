import type { HTMLAttributes, ComponentProps } from 'react';
import { Card } from './card';
import './EntityInventory.css';

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li'; variant?: 'platforms' | 'relay' };
export function EntityInventory({ as: Element = 'div', variant, className = '', ...props }: Props) {
  return <Element {...props} className={[variant === 'relay' ? 'relay-hosting' : variant === 'platforms' ? 'platforms-page' : '', className].filter(Boolean).join(' ')} />;
}
export function EntitySection({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}
export function EntityCard({ as: Element = 'div', ...props }: Omit<Props, 'variant'> & Pick<ComponentProps<typeof Card>, 'variant' | 'padded'>) {
  return <Card {...props} asChild><Element>{props.children}</Element></Card>;
}

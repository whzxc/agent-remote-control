import type { HTMLAttributes, ComponentProps } from 'react';
import { Card } from './card';
import './EntityInventory.css';

type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'li' };
export function EntityInventory({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}
export function EntitySection({ as: Element = 'div', ...props }: Props) {
  return <Element {...props} />;
}
export function EntityCard({ as: Element = 'div', ...props }: Props & Pick<ComponentProps<typeof Card>, 'variant' | 'padded'>) {
  return <Card {...props} asChild><Element>{props.children}</Element></Card>;
}

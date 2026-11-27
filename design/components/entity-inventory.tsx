import type { ReactNode } from "react";
import { Frame } from 'adg';
import { Card, type CardProps } from './card';
export function EntityInventory({ children, className: extra = '' }: { children: ReactNode; className?: string }) {
  return <div className={extra}>{children}</div>;
}
export function EntitySection({ children, className: extra = '' }: { children: ReactNode; className?: string }) {
  return <div className={extra}>{children}</div>;
}
export function EntityCard(props: CardProps) { return <Card {...props} />; }
export default () => <Frame name="content" width={480}><EntityInventory>
  <EntityCard variant="reply" className="border border-border px-4 gap-3!">
    <strong className="text-body leading-5 font-semibold">Personal</strong>
    <EntitySection className="text-meta leading-4 text-text-secondary">jordan@example.com · Connected</EntitySection>
  </EntityCard>
</EntityInventory></Frame>;

import { Frame } from 'adg';
import { Card, type CardProps } from './card';
export function EntityInventory({ children, class: extra = '' }: { children: unknown; class?: string }) {
  return <div class={extra}>{children}</div>;
}
export function EntitySection({ children, class: extra = '' }: { children: unknown; class?: string }) {
  return <div class={extra}>{children}</div>;
}
export function EntityCard(props: CardProps) { return <Card {...props} />; }
export default () => <Frame name="content" width={480}><EntityInventory>
  <EntityCard variant="reply" class="border border-border px-4 gap-3!">
    <strong class="text-body leading-5 font-semibold">Personal</strong>
    <EntitySection class="text-meta leading-4 text-text-secondary">jordan@example.com · Connected</EntitySection>
  </EntityCard>
</EntityInventory></Frame>;

import { Frame } from 'adg';
import { Card } from './card';
export function TaskReplyCard({ children }: { children: unknown }) {
  return <Card variant="reply" padded class="border border-border bg-transparent text-body leading-[22px]">{children}</Card>;
}
export function ContentProse({ children }: { children: unknown }) {
  return <div class="min-w-0 text-body leading-[22px]">{children}</div>;
}
export function PlanContent({ children }: { children: unknown }) {
  return <section class="text-small text-text-secondary">{children}</section>;
}
export default () => <Frame name="reply" width={512}><TaskReplyCard><ContentProse>Checks passed.</ContentProse><PlanContent>2 of 2 completed</PlanContent></TaskReplyCard></Frame>;

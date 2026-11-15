import { Frame } from 'adg';
import { Card } from './card';
export function TimelineSurface({ children, class: extra = '' }: { children: unknown; class?: string }) { return <section class={extra}>{children}</section>; }
export function ActivityHeading({ children }: { children: unknown }) { return <div class="text-title leading-6 font-[650]">{children}</div>; }
export function TaskFeedSection({ children }: { children: unknown }) { return <section class="text-small text-text-secondary">{children}</section>; }
export function TaskFilter({ children }: { children: unknown }) { return <div class="rounded-full border border-accent-text/40 bg-accent-text/10 text-small font-semibold text-accent-text">{children}</div>; }
export default () => <Frame name="timeline" width={512}><TimelineSurface><ActivityHeading>Task activity</ActivityHeading><Card padded>Review complete.</Card></TimelineSurface></Frame>;

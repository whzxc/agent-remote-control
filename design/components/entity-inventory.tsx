import { Frame } from 'adg';
import { Card } from './card';
export function EntityInventory({ children }: { children: unknown }) { return <div class="text-small text-text-secondary">{children}</div>; }
export function EntitySection({ children }: { children: unknown }) { return <div class="text-small text-text-secondary">{children}</div>; }
export default () => <Frame name="content" width={480}><EntityInventory><Card padded>Connected</Card></EntityInventory></Frame>;

export function EntityCard({ children }: { children: unknown }) { return <Card padded>{children}</Card>; }

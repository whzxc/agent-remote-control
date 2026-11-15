import { Frame } from 'adg';
import { Card } from './card';
export function DeviceFacts({ children }: { children: unknown }) { return <div class="text-small text-text-secondary">{children}</div>; }
export default () => <Frame name="content" width={480}><DeviceFacts><Card padded>Connected</Card></DeviceFacts></Frame>;

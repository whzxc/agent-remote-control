import { preference } from '../state/store';

export const mcpHubEnabled = preference('mcp-services', false, value => value === 'on', value => value ? 'on' : 'off');
/** readOnly and destructive repeat the downstream server's own annotations; they are hints, not guarantees. */
export type HubTool = { name: string; description?: string; readOnly?: boolean; destructive?: boolean };
export type HubServer = {
  name: string; transport: 'stdio' | 'http'; enabled: boolean; revision: number;
  state: 'ready' | 'idle' | 'connecting' | 'unchecked' | 'failed' | 'disabled';
  command?: string | null; endpoint?: string | null; envNames: string[]; headerNames: string[];
  addedBy?: { kind: 'source' | 'local' | 'import' | 'migration'; sourceLabel?: string | null; from?: string; by?: { sourceLabel?: string | null } | null } | null;
  toolCount?: number; tools?: HubTool[]; error?: string | null; observedAt?: string | null;
};
export type HubSnapshot = { enabled: boolean; servers: HubServer[]; observedAt: string };

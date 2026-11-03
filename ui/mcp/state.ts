import { preference } from '../state/store';

export const mcpServicesEnabled = preference('mcp-services', false, value => value === 'on', value => value ? 'on' : 'off');
export type McpTool = { name: string; description?: string; inputSchema?: unknown };
export type McpCheck = { state: 'unchecked' | 'ready' | 'failed'; checkedAt?: string; stage?: string; error?: string; protocolVersion?: string; tools: McpTool[] };
export type McpService = {
  id: string; name: string; transport: 'stdio' | 'http'; command: string; endpoint?: string | null;
  argsConfigured: boolean; envNames: string[]; headerNames: string[]; agents: string[]; revision: number;
  source?: { agent: string; name: string } | null; sourceChanged?: boolean; check: McpCheck;
};
export type McpSupport = { agent: string; displayName?: string; protocol: string; configurable: boolean; transports: string[]; owner: string };
export type McpSnapshot = {
  enabled: boolean; services: McpService[]; legacy: { agent: string; name: string; command: string; adoptedBy?: string | null }[];
  support: McpSupport[]; contextProviderConfigured: boolean;
};
export type NativeMcp = { name: string; authStatus: string; runtimeStatus?: string; tools: McpTool[] | Record<string, McpTool> };

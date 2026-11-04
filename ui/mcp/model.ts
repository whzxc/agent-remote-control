import type { HubServer } from './state';

export type FailureKind = 'auth' | 'start' | 'timeout' | 'network' | 'protocol';

/** Groups native hub error codes into the user-facing recovery categories. */
export function failureKind(error?: string | null): FailureKind {
  const code = (error ?? '').split(':', 1)[0].trim();
  if (code === 'MCP_HTTP_401' || code === 'MCP_HTTP_403') return 'auth';
  if (['MCP_COMMAND_NOT_FOUND', 'MCP_START_FAILED', 'MCP_STDIO_CLOSED', 'MCP_INVALID_COMMAND'].includes(code) || code.startsWith('MCP_MISSING_STD')) return 'start';
  if (code === 'MCP_TIMEOUT') return 'timeout';
  if (['MCP_CONNECTION_FAILED', 'MCP_CONNECTION_LOST', 'MCP_PROXY_FAILED'].includes(code) || code.startsWith('MCP_HTTP_')) return 'network';
  return 'protocol';
}

export function hubSummary(servers: readonly HubServer[]) {
  const enabled = servers.filter(server => server.enabled);
  return {
    total: servers.length,
    available: enabled.filter(server => server.state === 'ready' || server.state === 'idle').length,
    failed: enabled.filter(server => server.state === 'failed').length,
    tools: enabled.reduce((sum, server) => sum + (server.toolCount ?? 0), 0),
  };
}

/** Case-insensitive match on server name and tool names or descriptions. */
export function matchServer(server: HubServer, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return { server: true, tools: server.tools ?? [] };
  const tools = (server.tools ?? []).filter(tool => tool.name.toLowerCase().includes(needle) || (tool.description ?? '').toLowerCase().includes(needle));
  return { server: server.name.toLowerCase().includes(needle) || tools.length > 0, tools: server.name.toLowerCase().includes(needle) ? server.tools ?? [] : tools };
}

import type { HubServer, HubSnapshot, HubTool } from './state';

export type McpFixture = 'empty' | 'ready' | 'failed';
const at = '2026-01-01T00:00:00Z', earlier = '2025-12-31T23:42:00Z';
const tools: HubTool[] = [
  { name: 'search_docs', description: 'Search the sample documentation index', readOnly: true },
  { name: 'read_page', description: 'Read one documentation page by path', readOnly: true },
  { name: 'publish_page', description: 'Publish a reviewed draft to the sample documentation site', destructive: true },
];
export function mcpScenario(kind: McpFixture = 'empty') {
  const servers: HubServer[] = kind === 'empty' ? [] : [
    { name: 'docs', transport: 'http', enabled: true, revision: 1, state: kind === 'failed' ? 'failed' : 'ready', endpoint: 'https://tools.example/mcp', envNames: [], headerNames: ['Authorization'], observedAt: at,
      addedBy: { kind: 'source', sourceLabel: 'Claude' }, ...(kind === 'failed' ? { error: 'MCP_HTTP_401: Set the required Authorization or custom headers with mcp_configure update' } : { toolCount: tools.length, tools }) },
    { name: 'notes', transport: 'stdio', enabled: true, revision: 1, state: 'idle', command: 'notes-mcp', envNames: ['NOTES_TOKEN'], headerNames: [], observedAt: earlier,
      addedBy: { kind: 'import', from: 'codex' }, toolCount: 2, tools: [{ name: 'append_note', description: 'Append a note to the sample notebook' }, { name: 'list_notes', description: 'List recent notes in the sample notebook', readOnly: true }] },
    ...(kind === 'failed' ? [{ name: 'local-index', transport: 'stdio' as const, enabled: true, revision: 1, state: 'failed' as const, command: 'index-mcp', envNames: [], headerNames: [], observedAt: at,
      addedBy: { kind: 'local' as const }, error: 'MCP_COMMAND_NOT_FOUND: index-mcp was not found on ARC\'s Agent search path' }] : []),
    { name: 'archive', transport: 'stdio', enabled: false, revision: 2, state: 'disabled', command: '/opt/example/bin/archive-mcp', envNames: [], headerNames: [] },
  ];
  return (path: string, method: string, body?: unknown): unknown => {
    if (!path.startsWith('mcp-hub')) return undefined;
    if (path === 'mcp-hub' && method === 'GET') return structuredClone<HubSnapshot>({ enabled: true, servers, observedAt: at });
    const args = body as { action?: string; name?: string } | undefined;
    const index = servers.findIndex(server => server.name === args?.name);
    if (path !== 'mcp-hub/configure' || method !== 'POST' || index < 0) throw new Error('SCENARIO_ACTION_UNAVAILABLE: MCP hub');
    const server = servers[index];
    if (args?.action === 'remove') servers.splice(index, 1);
    else if (args?.action === 'disable') Object.assign(server, { enabled: false, state: 'disabled', revision: server.revision + 1 });
    else if (args?.action === 'enable') Object.assign(server, { enabled: true, state: 'ready', revision: server.revision + 1 });
    else if (args?.action === 'refresh') Object.assign(server, { state: 'ready', error: null, observedAt: at, toolCount: tools.length, tools });
    return structuredClone({ server });
  };
}

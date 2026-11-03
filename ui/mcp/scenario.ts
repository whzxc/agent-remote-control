import type { HubServer, HubSnapshot } from './state';

export type McpFixture = 'empty' | 'ready' | 'failed';
const tools = [
  { name: 'search_docs', description: 'Search the sample documentation index' },
  { name: 'read_page', description: 'Read one documentation page by path' },
];
export function mcpScenario(kind: McpFixture = 'empty') {
  const servers: HubServer[] = kind === 'empty' ? [] : [
    { name: 'docs', transport: 'http', enabled: true, revision: 1, state: kind === 'failed' ? 'failed' : 'ready', endpoint: 'https://tools.example/mcp', envNames: [], headerNames: ['Authorization'],
      addedBy: { kind: 'source', sourceLabel: 'Claude' }, ...(kind === 'failed' ? { error: 'MCP_HTTP_401: Set the required Authorization or custom headers with mcp_configure update' } : { toolCount: tools.length, tools }) },
    { name: 'notes', transport: 'stdio', enabled: true, revision: 1, state: 'idle', command: 'notes-mcp', envNames: ['NOTES_TOKEN'], headerNames: [],
      addedBy: { kind: 'import', from: 'codex' }, toolCount: 1, tools: [{ name: 'append_note', description: 'Append a note to the sample notebook' }] },
    { name: 'archive', transport: 'stdio', enabled: false, revision: 2, state: 'disabled', command: '/opt/example/bin/archive-mcp', envNames: [], headerNames: [] },
  ];
  return (path: string, method: string, body?: unknown): unknown => {
    if (!path.startsWith('mcp-hub')) return undefined;
    if (path === 'mcp-hub' && method === 'GET') return structuredClone<HubSnapshot>({ enabled: true, servers, observedAt: '2026-01-01T00:00:00Z' });
    const args = body as { action?: string; name?: string } | undefined;
    const index = servers.findIndex(server => server.name === args?.name);
    if (path !== 'mcp-hub/configure' || method !== 'POST' || index < 0) throw new Error('SCENARIO_ACTION_UNAVAILABLE: MCP hub');
    const server = servers[index];
    if (args?.action === 'remove') servers.splice(index, 1);
    else if (args?.action === 'disable') Object.assign(server, { enabled: false, state: 'disabled', revision: server.revision + 1 });
    else if (args?.action === 'enable') Object.assign(server, { enabled: true, state: 'ready', revision: server.revision + 1 });
    else if (args?.action === 'refresh') Object.assign(server, { state: 'ready', error: null, toolCount: tools.length, tools });
    return structuredClone({ server });
  };
}

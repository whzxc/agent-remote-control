import type { McpService, McpSnapshot, McpTool } from './state';

export type McpFixture = 'empty' | 'ready' | 'failed';
const tool: McpTool = { name: 'sample_echo', description: 'Return the supplied message from the sample service.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };
export function mcpScenario(kind: McpFixture = 'empty') {
  let next = 1;
  const snapshot: McpSnapshot = {
    enabled: true, contextProviderConfigured: true,
    support: [
      { agent: 'claude', displayName: 'Claude Code', protocol: 'acp-v1', configurable: true, transports: ['stdio', 'http-via-arc'], owner: 'arc-session' },
      { agent: 'dsh', displayName: 'DeepSeek Harness', protocol: 'acp-v1', configurable: true, transports: ['stdio', 'http-via-arc'], owner: 'arc-session' },
      { agent: 'codex', displayName: 'Codex', protocol: 'codex-native', configurable: false, transports: [], owner: 'native-profile' },
      { agent: 'pi', displayName: 'Pi', protocol: 'pi-rpc', configurable: false, transports: [], owner: 'native-profile' },
    ],
    services: kind === 'empty' ? [] : [{ id: 'sample-remote', name: 'sample-remote', transport: 'http', command: '', endpoint: 'https://tools.example/mcp', argsConfigured: false, envNames: [], headerNames: ['Authorization'], agents: ['claude', 'dsh'], revision: 1,
      check: kind === 'failed' ? { state: 'failed', checkedAt: '2026-01-01T00:00:00Z', stage: 'connect', error: 'MCP_HTTP_503: Inspect the upstream service, then check again.', tools: [] } : { state: 'ready', checkedAt: '2026-01-01T00:00:00Z', protocolVersion: '2025-11-25', tools: [tool] } }],
    legacy: [{ agent: 'dsh', name: 'local-sample', command: '/opt/example/bin/mcp-service' }],
  };
  return (path: string, method: string, body?: unknown): unknown => {
    if (!path.startsWith('mcp-services')) return undefined;
    const args = body as { id?: string; expectedRevision?: number; configuration?: Partial<McpService> & { url?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> }; agent?: string; name?: string } | undefined;
    if (path === 'mcp-services' && method === 'GET') return structuredClone({ ...snapshot, legacy: snapshot.legacy.map(source => ({ ...source, adoptedBy: snapshot.services.find(s => s.source?.agent === source.agent && s.source.name === source.name)?.id })) });
    if (method !== 'POST') throw new Error('SCENARIO_ACTION_UNAVAILABLE: MCP services');
    if (path === 'mcp-services/save') {
      const previous = snapshot.services.find(s => s.id === args?.id);
      if (previous && previous.revision !== args?.expectedRevision) throw new Error('MCP_CONFIG_CHANGED: Refresh before editing this service');
      const config = args?.configuration ?? {};
      if (snapshot.services.some(s => s.id !== previous?.id && s.name === config.name)) throw new Error('MCP_NAME_EXISTS: Choose another name');
      const service: McpService = { id: previous?.id ?? `sample-${next++}`, name: config.name!, transport: config.transport!, command: config.command ?? previous?.command ?? '', endpoint: config.url ? new URL(config.url).origin + new URL(config.url).pathname : previous?.endpoint,
        argsConfigured: config.args ? !!config.args.length : previous?.argsConfigured ?? false,
        envNames: config.env ? Object.keys(config.env) : previous?.envNames ?? [], headerNames: config.headers ? Object.keys(config.headers) : previous?.headerNames ?? [],
        agents: config.agents ?? [], revision: (previous?.revision ?? 0) + 1, source: previous?.source, check: { state: 'unchecked', tools: [] } };
      snapshot.services = [...snapshot.services.filter(s => s.id !== service.id), service];
      return structuredClone(service);
    }
    if (path === 'mcp-services/adopt') {
      const source = snapshot.legacy.find(s => s.agent === args?.agent && s.name === args.name);
      if (!source) throw new Error('MCP_SOURCE_NOT_FOUND');
      const service: McpService = { id: `sample-${next++}`, name: source.name, transport: 'stdio', command: source.command, argsConfigured: true, envNames: [], headerNames: [], agents: [source.agent], revision: 1, source: { agent: source.agent, name: source.name }, check: { state: 'unchecked', tools: [] } };
      snapshot.services.push(service); return structuredClone(service);
    }
    if (path === 'mcp-services/check') {
      const service = snapshot.services.find(s => s.id === args?.id);
      if (!service) throw new Error('MCP_SERVICE_NOT_FOUND');
      service.check = { state: 'ready', checkedAt: new Date().toISOString(), protocolVersion: '2025-11-25', tools: [tool] };
      return structuredClone(service);
    }
    if (path === 'mcp-services/remove') {
      const service = snapshot.services.find(s => s.id === args?.id);
      if (service?.revision !== args?.expectedRevision) throw new Error('MCP_CONFIG_CHANGED');
      snapshot.services = snapshot.services.filter(s => s.id !== args?.id); return { removed: true };
    }
    if (path === 'mcp-services/native') return { services: [{ name: 'native-sample', authStatus: 'bearerToken', runtimeStatus: 'connected', tools: { sample_echo: tool } }], checkedAt: new Date().toISOString() };
    if (path === 'mcp-services/native-login') return { state: 'pending' };
    throw new Error(`SCENARIO_ACTION_UNAVAILABLE: ${path}`);
  };
}

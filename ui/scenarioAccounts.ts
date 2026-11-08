import type { ProviderAccount, AccountLogin, AccountsResult, CodexAccountImport } from './types';
import type { Status, ControlSource } from './state/types';
// In-memory implementation of the native management routes in docs/reference/tools.md.
export function accountScenario(status: Status, sources: ControlSource[]) {
  const now = new Date().toISOString();
  const primary = status.ingresses[0];
  primary.url = 'https://arc.example.com/mcp';
  const chatgpt: ControlSource = { ...sources[0], id: 'example-chatgpt-source', ingressId: 'example-chatgpt-connection', product: 'chatgpt', platform: 'openai', label: 'Personal', credential: { type: 'ingress' } };
  sources.push(chatgpt);
  status.ingresses.push({ ...primary, id: chatgpt.ingressId, name: 'ChatGPT connection', transport: 'openai-tunnel', auth: 'openai', controlSource: 'chatgpt', sources: [chatgpt], url: 'https://chatgpt.example.com/mcp', oauth: { pending: [], grants: [] } });
  status.ingresses.push({ ...primary, id: 'example-spare-connection', name: 'Spare connection', transport: 'https', auth: 'oauth', sources: [], url: 'https://spare.example.com/mcp', oauth: { pending: [], grants: [] } });
  const accounts: ProviderAccount[] = [
    { id: 'account-source', provider: 'anthropic', identityKey: `anthropic:unidentified:${sources[0].id}`, alias: 'Unidentified', createdAt: now, observedAt: now, sources: [sources[0].id], agentProfiles: [], health: { state: 'ready' }, notifications: { state: 'not-bound', reachable: false, sessions: [] }, quota: { state: 'unavailable', windows: [] } },
    { id: 'account-claude', provider: 'anthropic', identityKey: 'anthropic:id:example-claude-identity', alias: 'Studio', email: 'alex@example.com', orgName: 'Example Studio', plan: 'Max', createdAt: now, observedAt: now, sources: [], health: { state: 'ready' }, agentProfiles: [{ agent: 'claude', profileId: 'profile-claude', kind: 'cli-profile', state: 'signed-in', default: true }], notifications: { state: 'verified', reachable: true, sessions: [{ target: 'session_010000000000000000000001', state: 'verified', verified: true, lastDelivery: { at: Math.floor(Date.now() / 1000), status: 'sent' } }] }, quota: { state: 'ready', windows: [{ id: 'five-hour', poolId: 'main', label: '5 h', usedPercent: 37, resetsAt: new Date(Date.now() + 7200000).toISOString() }, { id: 'weekly', poolId: 'main', label: '7 d', usedPercent: 68, resetsAt: new Date(Date.now() + 259200000).toISOString() }] } },
    { id: 'account-openai', provider: 'openai', identityKey: 'openai:id:example-openai-identity', alias: 'Personal', email: 'jordan@example.com', orgName: 'Example Lab', plan: 'Plus', createdAt: now, observedAt: now, sources: [chatgpt.id], health: { state: 'ready' }, agentProfiles: [{ agent: 'codex', profileId: 'codex-home', kind: 'codex-home', state: 'signed-in', default: true }], notifications: { state: 'mcp-events', reachable: true, sessions: [] }, quota: { state: 'ready', windows: [{ id: 'weekly', poolId: 'main', label: '7 d', usedPercent: 24, resetsAt: new Date(Date.now() + 86400000).toISOString() }] } },
    { id: 'account-review', provider: 'anthropic', identityKey: 'anthropic:id:example-review-identity', alias: 'Review', email: 'review@example.com', orgName: 'Example Review', createdAt: now, observedAt: now, sources: [], health: { state: 'attention' }, agentProfiles: [{ agent: 'claude', profileId: 'profile-review', kind: 'cli-profile', state: 'signed-out', default: false }], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } },
    { id: 'account-key', provider: 'deepseek', identityKey: 'deepseek:unidentified:api-key:dsh', alias: 'Unidentified', createdAt: now, observedAt: now, sources: [], health: { state: 'attention' }, agentProfiles: [{ agent: 'dsh', profileId: 'api-key:dsh', kind: 'api-key', state: 'unfinished', default: true }], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } },
  ];
  const connectedAccount = accounts.find(account => account.sources.includes(chatgpt.id))!;
  chatgpt.authorizationFacts = { email: connectedAccount.email ?? undefined, orgName: connectedAccount.orgName ?? undefined };
  let polls = 0, sequence = 0, login: AccountLogin | null = null;
  let loginAccount: string | undefined;
  const requireAccount = (id: string): ProviderAccount => {
    for (let hop = 0; hop <= accounts.length; hop++) {
      const account = accounts.find(a => a.id === id);
      if (!account) throw new Error('ACCOUNT_NOT_FOUND');
      if (!account.mergedInto) return account;
      id = account.mergedInto;
    }
    throw new Error('ACCOUNT_MERGE_CYCLE');
  };
  function completeLogin() {
    if (!login || !['claude', 'codex'].includes(login.kind)) return;
    const account = requireAccount(loginAccount ?? (login.kind === 'claude' ? 'account-claude' : 'account-openai'));
    account.agentProfiles.forEach(profile => { if (profile.agent === login!.kind) profile.state = 'signed-in'; });
    account.health.state = 'ready'; login = { ...login, state: 'completed', loginUrl: null, accountId: account.id };
  }
  function list(agent?: string): AccountsResult {
    if (login?.state === 'waiting' && ++polls >= 4) completeLogin();
    return { accounts: accounts.filter(a => !a.removedAt && (!agent || a.agentProfiles.some(p => p.agent === agent))).map(({ email, orgName, ...account }) => account), login };
  }
  return (path: string, method: string, raw?: unknown): unknown => {
    const route = path.split('?')[0], body = (raw ?? {}) as Record<string, string>;
    if (route === 'accounts' && method === 'GET') return list();
    if (route === 'accounts/query' && method === 'POST') return body.id ? requireAccount(body.id) : list(body.agent);
    if (route === 'accounts/browsers' && method === 'GET') return { browsers: [{ id: 'safari', name: 'Safari' }, { id: 'chrome', name: 'Chrome' }, { id: 'firefox', name: 'Firefox' }] };
    if (route === 'accounts/whoami' && ['POST', 'GET'].includes(method)) {
      const account = requireAccount('account-source');
      return { id: account.id, alias: account.alias, provider: account.provider, email: null, orgName: null, plan: null, sourceId: sources[0].id, platform: sources[0].platform, agentProfiles: account.agentProfiles, notifications: account.notifications };
    }
    if (route === 'accounts/merge' && method === 'POST') {
      const request = raw as { into: string; ids: string[]; alias?: string; quotaProviderId?: string | null };
      const target = requireAccount(request.into);
      for (const id of request.ids) {
        const member = requireAccount(id);
        if (member.id === target.id) continue;
        target.sources = [...new Set([...target.sources, ...member.sources])];
        target.agentProfiles = [...new Map([...target.agentProfiles, ...member.agentProfiles].map(profile => [`${profile.agent}:${profile.profileId}`, profile])).values()];
        target.mergedAccountIds = [...new Set([...(target.mergedAccountIds ?? []), member.id, ...(member.mergedAccountIds ?? [])])];
        target.notifications.sessions = [...new Map([...target.notifications.sessions, ...member.notifications.sessions].map(session => [`${session.sourceId ?? ''}:${session.target}`, session])).values()];
        target.email ??= member.email; target.orgName ??= member.orgName; target.plan ??= member.plan;
        if (!target.quota.windows.length) target.quota = member.quota;
        member.sources = []; member.agentProfiles = []; member.mergedInto = target.id; member.removedAt = now;
      }
      if (request.alias) target.alias = request.alias.trim();
      if (request.quotaProviderId !== undefined) target.quotaProviderId = request.quotaProviderId;
      if (request.quotaProviderId === null) target.quota = { state: 'unavailable', windows: [] };
      const defaults = new Set<string>();
      for (const account of accounts.filter(account => !account.removedAt)) for (const profile of account.agentProfiles) {
        if (!profile.default) continue;
        if (defaults.has(profile.agent)) profile.default = false;
        else defaults.add(profile.agent);
      }
      target.observedAt = now;
      return target;
    }
    if (route === 'accounts/import' && method === 'POST') {
      const request = raw as CodexAccountImport;
      const tokens = request.auth.tokens as { account_id?: string; access_token?: string } | undefined;
      if (!tokens?.access_token) throw new Error('CODEX_AUTH_INVALID');
      const id = `imported-${++sequence}`, profileId = `profile-${id}`;
      accounts.push({ id, provider: 'openai', identityKey: `openai:id:${tokens.account_id ?? id}`, alias: request.alias ?? 'Personal', createdAt: now, observedAt: now,
        sources: [], health: { state: 'ready' }, agentProfiles: [{ agent: 'codex', profileId, kind: 'codex-home', state: 'signed-in', default: false, refreshOwner: request.refreshOwner }], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } });
      return { state: 'completed', accountId: id, profileId, refreshOwner: request.refreshOwner };
    }
    if (['accounts/add', 'accounts/reauth'].includes(route) && method === 'POST') {
      const kind = (body.kind ?? body.agent) as AccountLogin['kind'];
      if (!['claude', 'codex', 'detect', 'api-key'].includes(kind)) throw new Error('ACCOUNT_NATIVE_LOGIN_REQUIRED');
      if (body.id) { const account = requireAccount(body.id); if (account.removedAt) throw new Error('ACCOUNT_REMOVED'); if (!account.agentProfiles.some(p => p.agent === body.agent)) throw new Error('ACCOUNT_AGENT_MISSING'); }
      polls = 0; loginAccount = body.id;
      if (kind === 'codex' && !body.id) {
        const id = `oauth-${++sequence}`;
        accounts.push({ id, provider: 'openai', identityKey: `openai:id:${id}`, alias: 'Personal', createdAt: now, observedAt: now, sources: [], health: { state: 'attention' },
          agentProfiles: [{ agent: 'codex', profileId: `profile-${id}`, kind: 'codex-home', state: 'unfinished', default: false }], notifications: { state: 'n/a', sessions: [] }, quota: { state: 'unavailable', windows: [] } });
        loginAccount = id;
      }
      login = { loginId: `example-login-${++sequence}`, kind, state: 'waiting', browserId: body.browserId, loginUrl: 'https://login.example.com/authorize' };
      if (kind === 'api-key') login = { loginId: login.loginId, kind, state: 'unfinished', errors: [], next: { message: "Configure the key using the Agent's native authentication, then call account_add with kind detect. ARC never stores an inference key in an account record." } };
      if (kind === 'detect') login = { loginId: login.loginId, kind, state: 'completed', errors: [] };
      return login;
    }
    if (route === 'accounts/login' && method === 'POST') {
      if (!login || body.loginId !== login.loginId) throw new Error('LOGIN_NOT_FOUND');
      if (body.action === 'cancel') { login = { ...login, state: 'cancelled', loginUrl: null }; return login; }
      if (body.action !== 'code') throw new Error('INVALID_LOGIN_ACTION');
      if (login.kind === 'codex') throw new Error('ACCOUNT_LOGIN_CODE_UNSUPPORTED');
      if (login.kind !== 'claude') throw new Error('ACCOUNT_NATIVE_LOGIN_REQUIRED');
      if (!body.code?.trim()) throw new Error('LOGIN_CODE_REQUIRED');
      polls = 3; return { submitted: true };
    }
    if (['accounts/update', 'accounts/remove'].includes(route) && method === 'POST') {
      const account = requireAccount(body.id);
      if (route === 'accounts/update') {
        if (account.removedAt) throw new Error('ACCOUNT_REMOVED');
        if (body.alias !== undefined) { if (!body.alias.trim()) throw new Error('ACCOUNT_ALIAS_REQUIRED'); account.alias = body.alias.trim(); }
        if (body.defaultFor) {
          if (!account.agentProfiles.some(p => p.agent === body.defaultFor)) throw new Error('ACCOUNT_AGENT_MISSING');
          accounts.forEach(a => a.agentProfiles.forEach(p => { if (p.agent === body.defaultFor) p.default = !a.removedAt && a.id === account.id; }));
        }
      } else {
        if (!['finish', 'cancel'].includes(body.running)) throw new Error('INVALID_RUNNING_POLICY');
        account.removedAt = now; account.health.state = 'removed'; account.displayName = `Removed account · ${account.alias}`; account.notifications.state = 'removed';
        account.agentProfiles.forEach(p => { p.default = false; });
      }
      return account;
    }
    const notification = route.match(/^accounts\/([^/]+)\/(send|test)$/);
    if (route === 'accounts/routes' && method === 'PUT' || notification && method === 'POST') {
      const account = requireAccount(notification ? decodeURIComponent(notification[1]) : body.accountId);
      if (account.removedAt) throw new Error('ACCOUNT_REMOVED');
      if (!account.agentProfiles.some(p => p.agent === 'claude')) throw new Error('ACCOUNT_AGENT_MISSING');
      if (!body.target?.trim()) throw new Error('INVALID_CLAUDE_SESSION');
      let session = account.notifications.sessions.find(s => s.target === body.target);
      if (!session) { session = { target: body.target, state: 'not-bound' }; account.notifications.sessions.push(session); }
      if (notification) session.lastDelivery = { at: Math.floor(Date.now() / 1000), status: 'sent' };
      // Sending or assigning a route does not synthesize a receiver acknowledgement.
      if (!account.notifications.sessions.some(s => s.verified)) { account.notifications.state = 'not-bound'; account.notifications.reachable = false; }
      return { accountId: account.id, target: body.target, ...(notification ? { status: 'sent' } : { assigned: true }) };
    }
    if (route.startsWith('accounts/')) {
      const id = route.slice('accounts/'.length);
      if (method === 'GET' && !id.includes('/') && accounts.some(a => a.id === decodeURIComponent(id))) return requireAccount(decodeURIComponent(id));
      throw new Error(`SCENARIO_ACTION_UNAVAILABLE: ${path}`);
    }
    const switchMatch = route.match(/^source\/([^/]+)\/switch$/);
    if (switchMatch && ['POST', 'DELETE'].includes(method)) {
      const source = sources.find(s => s.id === switchMatch[1]); if (!source) throw new Error('SOURCE_NOT_FOUND');
      if (method === 'POST') {
        const target = status.ingresses.find(i => i.id === body.ingressId); if (!target) throw new Error('INGRESS_NOT_FOUND');
        status.ingresses.forEach(i => { i.sources = i.sources?.filter(s => s.id !== source.id); });
        source.ingressId = target.id; source.state = 'connected'; target.sources = [...(target.sources ?? []), source];
      }
      source.pendingSwitch = undefined;
      return { source };
    }
    const sourceMatch = route.match(/^source\/([^/]+)(\/disconnect)?$/);
    if (sourceMatch && method !== 'GET') {
      const source = sources.find(s => s.id === sourceMatch[1]); if (!source) throw new Error('SOURCE_NOT_FOUND');
      if (sourceMatch[2] && method === 'POST') source.state = 'revoked';
      else if (method === 'PUT') { if (body.label) source.label = body.label; if (body.product) source.product = body.product; }
      else throw new Error(`SCENARIO_ACTION_UNAVAILABLE: ${path}`);
      return { source };
    }
    const ingressMatch = route.match(/^ingress\/([^/]+)$/);
    if (ingressMatch && method === 'PUT') {
      const ingress = status.ingresses.find(i => i.id === ingressMatch[1]); if (!ingress) throw new Error('INGRESS_NOT_FOUND');
      if (typeof raw === 'object' && raw && 'enabled' in raw) ingress.enabled = !!raw.enabled;
      return ingress;
    }
    return undefined;
  };
}

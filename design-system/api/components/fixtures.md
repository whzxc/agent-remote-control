# Arc.fixtures

Typed synthetic records, not a component. Pass records through template holes. The data is owned by `ui/design-mount/baseFixtures.ts` and `ui/design-mount/topologyAccounts.ts`. The clock is fixed, without changing Date or the host clock. No native login, accounts or live task content are read.

## Fields

| Field | Type | Contents |
| --- | --- | --- |
| `requests` | Synthetic request family | `now`, `question`, `permission`, `secretReceipt`, `authorization`, `ingress`, `deployment`, `member` |
| `tasks` | Synthetic task family | `now`, `session`, `receipt`, `timeline`; includes partial read-only evidence and secret history |
| `agentObjects` | Synthetic AGENT family | `agent`, `account`, `source`, `ingress`, `request`, `quotaStates`; includes several profiles and current/pending authorization |
| `dispatchSpecs` | Recorded spec fixtures | Native label snapshots and resolved, unresolved, missing, loading and failed catalogs |
| `tunnelFrames` | `{ landscape, portrait }` projected ArenaLayout frames | Fixed inputs for the arena wire painter |
| `now` | `number` | Fixed epoch milliseconds; Root's default clock |
| `accounts` | `ProviderAccount[]` | Six account identities, source associations, profiles and account quotas |
| `agents` | `Agent[]` | Claude, Codex and dsh inventory records |
| `sources` | `ControlSource[]` | Synthetic source records linked to the topology accounts |
| `ingresses` | `Ingress[]` | Synthetic local connection and its sources |
| `quotaSnapshots` | `ProviderSnapshot[]` | Two Claude account quota projections, including reset-credit disclosure data |
| `quotaStates` | `Record<QuotaState, ProviderSnapshot>` | States below |
| `activitySessions` | `(TrackedActivity & { agent: string })[]` | Five activities, including permission attention and completed unread activity |
| `activity` | `AgentActivitySnapshot` | The same sessions grouped by Agent |
| `choices` | `{ value: string; label: string }[]` | Claude and Codex choices |
| `labels` | `Record<"button" \| "notice" \| "empty" \| "loading" \| "status" \| "tag", string>` | Synthetic English example copy |

`QuotaState` is `ready | stale | refreshing | unavailable | blocked | exhausted | unknownReset | expiredCredit | empty`. Missing quota is represented by `null` for AgentQuotaIcon. No API routes are exposed by fixtures. Make a copy before modifying records for a design state.

The fixture families are data under `Arc.fixtures`, never separate component exports. Use `requests.now` or `tasks.now` for Root and explicit time props when mounting those records; other families use `Arc.fixtures.now`.

## Shared record types

The authoritative schemas are [ProviderSnapshot](../../../ui/subscriptions/types.ts), [domain records](../../../ui/types.ts), [sources and ingresses](../../../ui/state/types.ts), [Agent](../../../ui/state/agents.ts) and [TrackedActivity](../../../ui/state/activityModel.ts). Paths are relative to this file's directory.

```ts
type QuotaWindow = {
  id: string; poolId: string; label: string; scope?: string;
  usedPercent: number; resetsAt?: string; exhausted?: boolean;
};
type ProviderSnapshot = {
  providerId: string; agentId: string; agentIds: string[]; name: string;
  eligible: boolean; state: string; refreshing: boolean;
  windows: QuotaWindow[]; displayWindowId?: string;
  observedAt?: string; lastAttemptAt?: string;
  accountBlocked?: boolean; blockedPoolIds: string[];
  hasCredential: boolean; acceptsKey: boolean; credentialSource?: string;
  source?: string; rawUsage?: Record<string, unknown> | null;
  plan?: string; creditBalance?: number; availableResetCount?: number | null;
  resetCredits?: { expiresAt?: string; count?: number }[];
  productUsage?: {
    basis: 'consumed' | 'allowance'; shared: boolean;
    rows: { label: string; percent: number }[];
  };
  error?: { code: string; message?: string; retryAt?: string };
};
```

Account quota is `ProviderAccount['quota']`, a separate subset with `state`, `windows`, optional observation/blocking/error fields. Do not substitute a provider snapshot for account identity. AgentQuotaIcon accepts account quota; AgentQuota and QuotaBubble accept provider snapshots.

`TrackedActivity` extends `AgentActivitySession` with required numeric `orderAt` and optional numeric `endedAt`/`readAt`, boolean `conversation` and nullable string `status`. A session requires `id`, `source` (`arc-task | codex-thread | transcript`), `phase` (`thinking | command | file | tool | text | interaction | idle`), `headline`, nullable ISO `phaseSince` and boolean `timeline`. Optional title, project, dispatch summary, phase history and interaction fields keep their application types. Session ISO timestamps and tracked epoch timestamps are deliberately distinct.

## Canvas example

Values for the canvas `renderVals`:

```js
const renderVals = {
  privacy: false,
  now: Arc.fixtures.now,
  quota: Arc.fixtures.quotaStates.exhausted,
  refresh: async () => {},
};
```

```html
<x-import component-from-global-scope="Arc.Root" mode="light" locale="en" privacy="{{privacy}}" now="{{now}}">
  <x-import component-from-global-scope="Arc.QuotaBubble" provider="{{quota}}" on-refresh="{{refresh}}"></x-import>
</x-import>
```

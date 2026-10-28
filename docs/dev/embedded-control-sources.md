# Embedded control sources

### Ownership and compatibility

Desktop provides one plain native window per account with a direct wry child. Core owns the account-scoped conversation registry and task bindings. The renderer API is defined in `ui/srcConversations.ts`; native WebView lifecycle remains with Desktop.

The native implementation requires macOS 14 or later for identifier-based persistent WK data stores. Other platforms and non-Claude source providers report `unsupported`. Core owns the persisted registry and account scope; Desktop owns native windows and login import. There is no Tauri remote webview, remote IPC handler, initialization script, DOM read, history database scan, or page-content API. Construction verifies that the native user-script count is zero before any navigation.

A random store UUID is generated on the first open/import for each canonical ARC account ID and saved before creating its native view. Reopening reuses that store. Closing destroys the view; no hidden residency is retained. Re-import replaces the loaded view with a blank view of the same store and reuses its plain host window. Account merges never transfer a website session implicitly: historical stores remain keyed to their original IDs, and the canonical owner uses its own store. Store migration is deferred. `src_login_clear` deletes only the selected native website store and its mapping; conversation metadata and task bindings remain.

### Import and URL observation

`src_chrome_profiles` reads only profile directories and display names from Chrome Local State. Import accepts only a listed directory beneath the Chrome root. The importer uses a private database copy with WAL/SHM and before/after stamps, Chrome v10 decryption and version-24 host digest validation, and the same domain allowlist and Cloudflare exclusions. Partitioned and expired persistent cookies are skipped. No cookie values or keys enter ARC JSON state, receipts, logs or API results. WebKit retains its own persistent website store.

`src_login_import` validates the account and profile, starts a Desktop-owned background job, and returns immediately with `{accountId,status:"importing",next:{via:"query",op:"src_conversations",args:{accountId},hint}}`. Import jobs are scoped to the account; a concurrent import for the same account returns the existing in-flight state without starting another worker. Opening that account during import also returns the in-flight state. The first Keychain prompt requires typing the macOS login password and choosing Always Allow; the background wait is **180 seconds**. A still-pending OS request prevents another Keychain request; denial is never bypassed. The process disables core dumps before import. Every native cookie representation is validated before submitting any cookie writes. Navigation waits for all `WKHTTPCookieStore` completion callbacks, with a 30-second blocker timeout. Pending write barriers survive caller cancellation and window closure; another open cannot bypass them. Metadata queries and other account windows remain available during the background wait. A failed or timed-out import is not a signed-in result.

Before any native cookie write or view replacement, ARC compares the imported `lastActiveOrg` UUID in-process with the selected SRC account's confirmed handshake organization. New handshakes snapshot `orgId`. For an existing handshake without that field, ARC may read its pinned profile's cached identity only when its identity key still matches the handshake. It does not read a page, DOM, or provider API, and it does not infer organization ownership from email or aliases.

- A matching organization permits installation.
- An organization matching another known SRC account yields `import-mismatch` with `detectedAccountId` and a hint to select that ARC account. No cookie is installed into the selected container. `allowUnverified` never overrides this result.
- A missing, malformed, conflicting, or unknown organization yields `import-unverified`. No cookie is installed unless the caller explicitly retries `src_login_import` with `allowUnverified:true`.

Cookie values and the imported organization UUID are never returned, logged, or added to ARC state. Only the comparison outcome and the matched ARC account ID cross the public interface. Organization matching is the import ownership check; URL-based login status still does not prove account identity. The check does not retroactively validate an already-imported store.

The native URL poll runs on a 250 ms cadence. Only canonical `/chat/<uuid>` and `/cowork/cse_<id>` URLs cross into Core. Query strings, fragments and unrelated paths are discarded. `expired` is set on `/login`, `/signin`, `/sign-in`, `/sign_in` or `/auth`. A finished claude.ai page whose URL remains stable for five seconds yields `signed-in`. This is a URL heuristic, not an authentication or content assertion. New views start `not-imported`. Import progress is reported separately through the same status field:

| Status | Meaning |
| --- | --- |
| `importing` | The background job is copying/decrypting cookies, waiting for Keychain, writing cookies, or starting navigation. Poll the existing account. |
| `signed-in-pending` | Cookies were installed and navigation started; no URL-based login result is available yet. |
| `not-imported` | No cookies were imported, or no import has started. Subsequent native URL evidence can still resolve the store state. |
| `import-blocked` | The job ended without completing. `reason` and `hint` identify the blocker and required human action. |
| `import-mismatch` | The imported org belongs to another known SRC; `detectedAccountId` identifies that account. No cookies were installed. |
| `import-unverified` | Org ownership is unknown or missing. Explicit `allowUnverified:true` is required before installation. |
| `signed-in`, `expired` | The native URL observation resolved the login heuristic. |
| `unsupported` | This platform/provider cannot host the container. |

Blocked reasons include `keychain-timeout`, `keychain-denied`, `keychain-pending`, `keychain-unavailable`, `cookie-write-timeout`, `cookie-write-pending`, `chrome-profile-unavailable`, `window-closed`, `import-interrupted` and `import-failed`. Keychain hints direct the user to enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow. Failures expose only these safe codes and fixed hints, never native error payloads. An interrupted Desktop job becomes `import-blocked` on the next complete metadata sync. A completed empty import returns `not-imported`; a nonempty import returns `signed-in-pending` until URL observation resolves it. Retry requires a new explicit action after the blocker is handled.

Safari UA override is per account and defaults to false. `src_conversation_open` can save it; an already-open view must be closed before the changed preference takes effect. The optional compatibility string uses `Version/27.0.1 Safari/605.1.15` with the frozen WebKit token; it is not an assertion about the host Safari version. Default wry UA is the normal route. Popups and navigation outside the HTTPS claude.ai origin are denied.

### Registry and task bindings

The registry persists canonical account ID, conversation kind/ID/URL, session `aliases:[]`, first and last observation times, last active time, and provenance. Linked tasks persist separately and are projected as `taskRefs:[{agent,id,basis}]`. A conversation's `basis` describes its initial evidence (`observed` or `notify-target`); each task binding has its own `notify-target`, `correlated` or `manual` basis. First observations, status changes, bindings and window transitions save immediately; continuous timestamp updates are coalesced for at most 30 seconds. Live window state is never restored as open after Core restart.

When a source-owned Claude session handshake is confirmed, exactly one same-account Chat with activity in the preceding **600 seconds** receives `cse_<suffix>` as a persistent alias. The Chat keeps its ID, URL, kind and initial evidence. A pre-existing Cowork record for that session merges into the Chat, retaining the earliest first observation and the union of task references. With zero or multiple eligible Chats, `session_<24 alphanumeric characters>` registers separately as `/cowork/cse_<suffix>`. Registry reads resolve existing aliases without correlating historical targets or migrating other old Cowork records. Dispatch uses its explicit verified target, or the exact same source/Codex task's still-open inherited notification binding. It never selects an arbitrary account-wide notification target. An unverified explicit target leaves the task unbound.

Session task binding derives from the dispatch notify target, including a verified late bind with `threadId`. An aliased session resolves to its canonical Chat with task basis `notify-target`, taking precedence over `correlated`; manual corrections remain manual. Late-bind completion catch-up pushes are intentional and unchanged. Cowork dispatches without notify stay unbound by design; observing a Cowork URL in an account window does not supply a dispatch notify target.

Chat dispatch snapshots the native window again, with a one-second metadata deadline. Missing Desktop, a failed snapshot or a closed window leaves the task unbound. Only the same account's current Chat URL qualifies, with a native observation no older than two seconds and focused, visible, non-minimized activity within **600 seconds**. The association is captured before execution, so a slow submission cannot follow a later navigation. A queued send is evaluated when it actually dispatches. Non-Claude sources and local authority do not gain inferred cloud conversation bindings.

`src_conversation_bind` allows manual rebind/unbind only to a registered conversation of the task's origin account; a session alias resolves to its canonical Chat. The next new dispatch/send evaluates automatic association again; a native resume retains the existing binding. `codex_read` and `agent_read` expose nullable `srcConversation:{accountId,kind,id,url,basis}`. No task is guessed across accounts.

### Operations and bridge

| Entry | Operation | Arguments |
| --- | --- | --- |
| query | `src_conversations` | `{accountId?}` |
| query | `src_chrome_profiles` | `{}` |
| act | `src_conversation_open` | `{accountId, conversationId? or url?, safariUserAgent?}` |
| act | `src_login_import` | `{accountId,profile,allowUnverified?}` |
| act | `src_login_clear` | `{accountId}` |
| act | `src_conversation_bind` | `{accountId,agent,taskId,conversationId:string|null}` |

Omitting both navigation arguments opens `https://claude.ai/new`. Explicit URLs must be `/new` or valid Chat/Cowork URLs on the same HTTPS claude.ai origin, without credentials, nonstandard ports, query strings or fragments. `src_conversations` lists every SRC account, even when no container exists; those accounts start `not-imported` (or `unsupported` for another platform/provider). Reads reconcile source ownership before listing and never apply mutation ownership filtering. External write operations remain restricted to the calling account; local management may select any source account. Import returns progress metadata (`accountId`, `status`, nullable `reason`/`hint`) and a `next` polling call, never credentials. Mutations use the existing `read-back` retry contract: no receipt replay protection, no automatic retry, and no extra guarantee from `act.requestId`.

Local management mirrors these operations at `POST src-conversations/{query,open,import,clear,bind}` and `GET src-conversations/profiles`. CLI names are `src.conversations.{query,profiles,open,import,clear,bind}`. The internal Desktop metadata channel reports URL-derived state only. It is not exposed as a remote MCP operation.

`ui/scenarioSrcConversations.ts` supplies signed-in, expired, not-imported, unsupported, importing, signed-in-pending, import-blocked, import-mismatch and import-unverified states, Chat/Cowork refs, linked tasks and manual binding transitions through the same API routes in browser fixtures. It does not simulate Keychain, native WebKit, or authentication. Panel buttons, L3 cards and task links are deferred to the UI segment; native login, isolation and lifecycle acceptance require a separately authorized main-checkout run.

### Clear a login container

`src_login_clear({accountId})` closes the account window, releases its WKWebView, and calls `WKWebsiteDataStore.removeDataStoreForIdentifier`. ARC waits for the native completion before removing the persisted store UUID mapping and live observation. The result is `{accountId,status:"not-imported"}`; the next open/import creates a fresh random UUID. Conversations and task bindings are retained. Chrome is not modified or signed out.

An in-flight import or pending cookie write must finish before clear can proceed. Native deletion failure or a 30-second completion timeout retains the mapping and blocks reopening/import until another explicit clear confirms deletion. Clear is safe to repeat after confirmation. Existing incorrectly attributed stores can be removed through this operation; they are never silently reused as verified imports.

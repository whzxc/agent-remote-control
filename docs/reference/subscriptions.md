# Subscription quota reference

[Home](../../README.md) · [CLI settings](cli.md#subscription-settings)

ARC reads native provider login and upstream responses. Quota monitoring runs in Core independently of ingress connections. Agent management controls which providers participate; its settings control the home display and quota panels.

## Sources

| Source | Quota / plan |
| --- | --- |
| Codex / ChatGPT | Native account quota windows, plan, reset credits |
| Claude | Native Claude Code `/usage` quota windows |
| OpenCode Go | Existing OpenCode subscription response |
| Cursor | Native login, included-period quota, X Pass |
| Antigravity | Running language server; macOS login fallback |
| Grok | Native login, CLI billing quota and reported plan |
| Kimi | Saved API key and membership/quota response |

Display grouping puts Cursor Agent under Cursor and Grok CLI/Build under Grok. Antigravity readings belong to Antigravity and are not attached to Gemini CLI. A standalone Antigravity installation can contribute readings to the quota overview without an ARC execution adapter. Execution adapters and authentication remain separate. Missing quota is unknown; a provider can return a plan without quota values.

## Refresh and cached readings

Successful quota readings persist in private ARC state. Startup restores them as stale while refresh runs. Failed requests retain the last reading and retry with backoff; 401/403 remain upstream errors. Readings become stale after 15 minutes; expired windows are hidden. Disabling an Agent or monitoring or explicitly removing credentials clears its quota cache.

Codex obtains a native account reader on refresh. Claude runs the installed CLI's built-in `/usage` command without tools, project settings, MCP servers or a persisted session. Claude Code owns its login and renewal. Cursor reads its native Keychain token on macOS, then its native `auth.json`, then the desktop token. Its merged plans report one included weekly or monthly window according to the upstream plan; older plans retain their model pools. Antigravity token renewal belongs to Antigravity. Grok reads `GROK_HOME/auth.json`, defaulting to its native home, and requests `/v1/billing?format=credits`. After an upstream 401, ARC rereads the login, asks the installed `grok models` command to renew it when unchanged, then retries once. ARC never exchanges a rotating refresh token itself. Interrupted JSON writes are reread before reporting a failure. Both native commands honor ARC's network proxy setting.

## Display and controls

Agent settings offer 4/6/8/10 home entries, Remaining/Used display, countdown/date reset preferences, and refresh intervals of 1/3/5/10 minutes. Monitoring and refresh intervals are saved in Core. Eligible providers participate automatically with their Agent; there are no per-provider display switches or window selectors. Home rings always use weekly quota and remain absent when no weekly window is reported. The quota overview and Agent details retain other reported windows.

An Agent's switch controls managed requests, monitoring and related displays. Disabling cancels refresh and clears current readings; it does not terminate a running Agent task. Codex's dedicated codex_* execution path is independent. Enabled installed entries appear first, preserving manual ordering.

Hover/focus quota blocks, reset credits, or product shares for details. Manual refresh is on the bubble. Plan titles open the provider's usage page; OpenCode opens Console.

## Pace

Consumption pace is used quota divided by elapsed reset-window time. The forecast starts after at least 60 seconds or 1% of a cycle. Under 5% used, unstable near-limit forecasts are suppressed. Stale/expired windows and zero use do not produce forecasts.

Green indicates at least 10% projected remaining at reset; amber indicates less. Red requires strictly under 25% remaining and projected exhaustion before reset. An even-pace tick follows Remaining/Used display. Upstream exhaustion/blocking is reported separately.

Provider-reported reset counts show currently usable grants and expiry; ARC does not redeem them. X Pass product shares preserve upstream fractions rather than normalizing to 100%. Independent refreshes can capture different times; missing breakdowns are not inferred from another provider's login. Claude Code `/usage` does not expose the former HTTP response's reset grants or product breakdown; new CLI readings contain only reported quota windows.

## Limits

Quota availability comes from the provider. Cached values do not trigger live alerts or pace forecasts. ARC does not collect local usage logs, count Tokens, or estimate charges. Provider-reported credits and product shares are displayed as quota information.

## Agent associations

`subscriptions/settings.json` in the ARC state directory accepts `agentProviders`, an object from agent IDs to provider ID arrays. It is also returned and updated by `cli subscriptions get` / `cli subscriptions set --stdin`. For example:

```json
{
  "enabled": true,
  "refreshMinutes": 3,
  "agentProviders": {"opencode": ["opencode-go"], "dsh": ["opencode-go"]}
}
```

An explicit array replaces that agent's default association; an empty array removes it. Omitted agents retain their built-in association. Each provider is read once and its snapshot advertises `agentIds`; `agentId` still identifies its native credential source and branding. Agent quota displays and `dispatch_policy` use `agentIds`. Associations describe shared billing only and do not select the agent's model or route; configure the native route separately. `modelAssociation: "unknown"` remains explicit until the upstream provides that evidence.

## Antigravity control-source notifications

Antigravity quota discovery is independent of local MCP access and notifications.
An Antigravity control source can bind its native conversation with
`notify_control` and acknowledge the delivered challenge using `notification_ack`.
Dispatches use the returned `antigravity-session` notify object; `notify_status`
reports reachability and delivery. The Desktop `agentapi` transport probes metadata
before each send and requires a matching recipient in the response. See
[Antigravity notification targets](tools.md#antigravity-notification-targets).

# Subscription quota reference

[Home](../../README.md) · [CLI settings](cli.md#subscription-settings)

ARC reads native provider login and upstream responses. Quota monitoring runs in Core independently of ingress connections. Agent management controls which providers participate; its settings control the home display and quota panels.

## Sources

| Source | Quota / plan |
| --- | --- |
| Codex / ChatGPT | Native account quota windows, plan, reset credits |
| Claude | Native login, quota windows, reset grants, product shares |
| OpenCode Go | Existing OpenCode subscription response |
| Cursor | Desktop login, billing-cycle quota, X Pass |
| Antigravity | Running language server; macOS login fallback |
| Grok | Native login, reported plan/quota, X Pass |
| Kimi | Saved API key and membership/quota response |

Display grouping puts Cursor Agent under Cursor and Grok CLI/Build under Grok. Antigravity readings belong to Antigravity and are not attached to Gemini CLI. A standalone Antigravity installation can contribute readings to the quota overview without an ARC execution adapter. Execution adapters and authentication remain separate. Missing quota is unknown; a provider can return a plan without quota values.

## Refresh and cached readings

Successful quota readings persist in private ARC state. Startup restores them as stale while refresh runs. Failed requests retain the last reading and retry with backoff; 401/403 remain upstream errors. Readings become stale after 15 minutes; expired windows are hidden. Disabling an Agent or monitoring or explicitly removing credentials clears its quota cache.

Codex obtains a native account reader on refresh. Cursor prefers its desktop token, falling back to Keychain when absent. Antigravity token renewal belongs to Antigravity.

## Display and controls

Agent settings offer 4/6/8/10 home entries, Remaining/Used display, countdown/date reset preferences, and refresh intervals of 1/3/5/10 minutes. Monitoring and refresh intervals are saved in Core. Eligible providers participate automatically with their Agent; there are no per-provider display switches or window selectors. Home rings always use weekly quota and remain absent when no weekly window is reported. The quota overview and Agent details retain other reported windows.

An Agent's switch controls managed requests, monitoring and related displays. Disabling cancels refresh and clears current readings; it does not terminate a running Agent task. Codex's dedicated codex_* execution path is independent. Enabled installed entries appear first, preserving manual ordering.

Hover/focus quota blocks, reset credits, or product shares for details. Manual refresh is on the bubble. Plan titles open the provider's usage page; OpenCode opens Console.

## Pace

Consumption pace is used quota divided by elapsed reset-window time. The forecast starts after at least 60 seconds or 1% of a cycle. Under 5% used, unstable near-limit forecasts are suppressed. Stale/expired windows and zero use do not produce forecasts.

Green indicates at least 10% projected remaining at reset; amber indicates less. Red requires strictly under 25% remaining and projected exhaustion before reset. An even-pace tick follows Remaining/Used display. Upstream exhaustion/blocking is reported separately.

Claude reset counts show currently usable grants and expiry; ARC does not redeem them. Claude and X Pass product shares preserve upstream fractions rather than normalizing to 100%. Independent refreshes can capture different times; missing breakdowns are not inferred from another provider's login.

## Limits

Quota availability comes from the provider. Cached values do not trigger live alerts or pace forecasts. ARC does not collect local usage logs, count Tokens, or estimate charges. Provider-reported credits and product shares are displayed as quota information.

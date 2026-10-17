# Subscription and usage reference

[Home](../../README.md) · [CLI settings](cli.md#subscription-and-panel-settings)

ARC reads native provider login and upstream responses. Quota monitoring runs in Core independently of ingress connections. Agent management controls which providers participate; its settings control the home display and macOS rail.

## Sources

| Source | Quota / plan | History |
| --- | --- | --- |
| Codex / ChatGPT | Native account quota windows, plan, reset credits | Local Codex rollouts |
| Claude | Native login, quota windows, reset grants, product shares | Local Claude Code logs |
| OpenCode Go | Existing OpenCode subscription response | Available upstream fields |
| Cursor | Desktop login, billing-cycle quota, X Pass | Account token CSV export |
| Antigravity | Running language server; macOS login fallback | Local conversation records |
| Grok | Native login, reported plan/quota, X Pass | Available upstream fields |
| Kimi | Existing login and membership/quota response | Available upstream fields |

Display grouping puts Cursor Agent under Cursor, Gemini under Antigravity, and Grok CLI/Build under Grok. Execution adapters and authentication remain separate. Missing quota is unknown; a provider can return a plan without quota values.

## Refresh and cached readings

Successful quota readings persist in private ARC state. Startup restores them as stale while refresh runs. Failed requests retain the last reading and retry with backoff; 401/403 remain upstream errors. Readings become stale after 15 minutes; expired windows are hidden. Disabling a provider/monitoring or explicitly removing credentials clears its quota cache.

History refresh is independent of quota authentication. Codex, Claude, and Antigravity read device-local logs; Cursor uses its account export. A failed history refresh preserves previous history. Codex obtains a native account reader on refresh. Cursor prefers its desktop token, falling back to Keychain when absent. Antigravity token renewal belongs to Antigravity.

## Display and controls

Agent settings offer 4/6/8/10 home entries, a small/standard/large rail, compact/standard/roomy spacing, Remaining/Used display, countdown/date reset times, and refresh intervals of 1/3/5/10 minutes. Usage periods are Today, Yesterday, Last 7 Days, and Last 30 Days; the latter two include today using local calendar days.

An Agent's switch controls managed requests, monitoring, collection, and related displays. Disabling cancels refresh and clears current readings; it does not terminate a running Agent task. Codex's dedicated codex_* execution path is independent. Enabled installed entries appear first, preserving manual ordering.

Hover/focus quota blocks or period values for details. Manual refresh is on the bubble. Plan titles open the provider's usage page; OpenCode opens Console. The macOS rail can dock at an edge or float. Hide hides the rail without stopping monitoring; Settings opens preferences. Native panel behavior is macOS-only, while a browser preview shares rendering.

## Pace and estimates

Consumption pace is used quota divided by elapsed reset-window time. The forecast starts after at least 60 seconds or 1% of a cycle. Under 5% used, unstable near-limit forecasts are suppressed. Stale/expired windows and zero use do not produce forecasts.

Green indicates at least 10% projected remaining at reset; amber indicates less. Red requires strictly under 25% remaining and projected exhaustion before reset. An even-pace tick follows Remaining/Used display. Upstream exhaustion/blocking is reported separately.

Claude reset counts show currently usable grants and expiry; ARC does not redeem them. Claude and X Pass product shares preserve upstream fractions rather than normalizing to 100%. Independent refreshes can capture different times; missing breakdowns are not inferred from another provider's login.

## Token and dollar accounting

Codex merges duplicate plain and Zstandard-compressed rollouts in active/archive folders using response-aware accounting. Claude reads projects/**/*.jsonl under CLAUDE_CONFIG_DIR or ~/.claude, including subagents; cumulative records with the same message ID count once. Cache reads and 5-minute/1-hour writes have separate prices. Local logs include device activity across account changes; they are not filtered into a full current-account invoice.

API-equivalent USD uses bundled/cached prices, refreshed hourly with 30-minute retry after failure. Precedence is the [OpenUsage supplement](https://robinebers.github.io/openusage/pricing_supplement.json), [LiteLLM](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json), then [models.dev](https://models.dev/api.json). Unknown prices retain tokens and mark costs incomplete. Repricing can change estimates without changing token counts. Price requests send no credentials or usage records; attribution is in [LICENSE.OpenUsage](../../shared/pricing/LICENSE.OpenUsage).

Cycle estimates use timestamped samples from the last 32 days and the reported quota window. The sample ends at the earlier quota/history observation with at most five minutes of skew; it needs at least 1% use and priced tokens throughout. Device-local/incomplete history and stale snapshots do not support account-window extrapolation. Ambiguous separate model pools are excluded.

## Limits

Quota availability comes from the provider. Device-local histories omit other devices and web chats; costs are API-price equivalents, not subscription charges. Incomplete logs, account changes, early resets, and changing model mix limit extrapolation. Cached values do not trigger live alerts or pace forecasts.

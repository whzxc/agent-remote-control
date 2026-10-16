# Subscription usage

Quota monitoring uses the shared native core and works independently of ingress
connections. A working CLI or a free plan does not guarantee that its provider exposes
quota readings. Missing quota data is not treated as a full allowance.

## Cached readings

All providers persist their last successful reading in the private local state directory.
Readings are restored during core initialization, before Agent discovery or network
requests, so home quota rings can display cached values immediately.
Restored readings are marked stale while quota refresh runs in the background;
they do not trigger live quota alerts or consumption forecasts. Failed requests retain
the last reading and retry with backoff, including authentication failures. The server's
401 and 403 responses are reported separately without inferring credential expiry.
Readings become stale after 15 minutes. Expired quota windows are hidden.
Disabling monitoring or a provider and explicitly removing credentials clear the cache.
Corrupt caches are ignored. Only successful readings are saved.

Providers use the available native login or configured key without account comparisons,
credential fingerprints or local expiry checks. Codex uses a short-lived native reader
on each refresh to pick up the current login. Cursor prefers its desktop database token
and uses Keychain only when that token is unavailable.

Quota and usage history refresh independently. Codex, Claude Code and Antigravity scan local logs
without requiring credentials or a successful quota request. These logs describe local
device activity and are not filtered by the current account. Cursor's account export
uses its current credentials. A history failure preserves the previous history.

## Sources

| Brand | Data source and scope |
| --- | --- |
| Codex / ChatGPT | Existing Codex account: quota windows, reported plan including Pro 5x/20x, available reset credits and their expiry dates; local rollout token history |
| OpenCode Go | Existing OpenCode credentials and subscription usage response |
| Claude | Existing Claude login, subscription quota windows, available reset grants and weekly product shares; local Claude Code token history |
| Cursor | Existing desktop login, plan and billing-cycle quotas; merged X Pass allowance and product consumption; account token CSV export |
| Antigravity | Running local language server, or supported macOS login fallback; model-group quotas and local conversation token history |
| Grok | Existing login and reported plan, including Free; reported quota and X Pass product consumption |
| Kimi | Existing credentials and reported membership/quota data |

Sources depend on provider availability, authentication and platform support. Agent
execution and subscription authentication retain their own identities. Display grouping
combines Cursor with Cursor Agent, Antigravity with Gemini CLI, and Grok CLI/Build under
Grok; it does not change the underlying execution adapters.

Antigravity’s macOS login fallback uses the existing access token. If it expires, open
Antigravity and refresh its login; CLC does not renew the token itself.

## Controls and display

Open Agents management from the home graph's More button, then use the settings icon
beside its title. Settings have three groups:

- **Appearance:** show the quota rail, small/standard/large size, compact/standard/roomy
  spacing, and 4/6/8/10 home Agents (default 4). Home entries must be installed and enabled.
- **Quota:** remaining or used percentages, reset countdown or date/time, and automatic
  refresh every 1/3/5/10 minutes (default 3).
- **Usage:** independently show Today, Yesterday, Last 7 Days and Last 30 Days. The latter
  two include today and use local calendar days.

The switch on each Agent controls managed requests, quota monitoring, usage collection
and related displays. Disabling an Agent cancels its quota refresh and clears its current
readings; enabling it resumes monitoring. Enabled, installed Agents appear first, with
manual ordering preserved within each group. Enabling the rail enables global monitoring
but does not enable disabled Agents; with no available sources, settings display an explanation.

The status-bar panel follows its content height up to 704 logical pixels or the available
screen height, whichever is smaller. Longer content scrolls above the footer.

Each quota bubble has a manual refresh button. Plan titles open the provider's usage page or service homepage. OpenCode currently opens
Console because its usage response does not supply a workspace identity.
Quota windows are named 5h, weekly or monthly. Remaining display uses 额度 in Chinese;
used display uses 限额. Countdown text uses units such as `4d 2h`; 5h windows also show minutes.

In the home Agent details panel, hover the reset count or a period’s right-hand
statistics to open details anchored to that text. Labels and blank row space do not
trigger details. In the rail and menu-bar panel, the entire row remains a hover target.
Reset-count details show individual credit expiry dates; period details show model-level
tokens and estimated cost. The rail uses horizontal
secondary bubbles matching its colors. Missing subscription information is shown as
“未获取到订阅信息”; a reported plan can still appear without quotas.

The macOS rail supports edge docking and a floating capsule. Its context menu contains
Settings, Restore defaults and Hide. Settings opens the preferences panel, not Agent
management. Hide only hides the rail; it does not disable quota monitoring. Docked rails
collapse when idle and expand on pointer entry. The browser preview shares these visuals
but stores its position separately from the native screen placement.

## Consumption pace

For a known reset window, average consumption is used quota divided by elapsed time.
The bubble projects when the remaining quota would run out at that rate. A reference
tick marks even consumption across the cycle and flips with Used/Remaining mode.
Green means at least 10% is projected to remain at reset, amber means less headroom,
and red warning requires both strictly less than 25% remaining and projected exhaustion before reset. Exactly 25% remaining does not warn. Rings, progress bars and the rail share this fixed rule; missing reset/cycle data does not imply a warning. Confirmed exhaustion and upstream blocking remain separate unavailable states. Hovering anywhere in the quota block (label, bar or remaining/reset row) opens its secondary bubble.

Projection waits for at least 60 seconds or 1% of the cycle. Under 5% used, unstable
near-limit/over-limit projections are suppressed. Zero usage, stale readings and unknown
or expired windows do not generate a burn-rate forecast. Estimates are cycle averages,
not measurements of only the last few minutes; a change in usage rate changes the outcome.

## Product usage and resets

Claude reset grants are requested through the existing CLI OAuth login with the
installed CLI version. The reset count includes grants the provider reports usable
now; details show the remaining count and expiry. This display
does not redeem resets. Weekly product shares describe the distribution of consumed
usage, not a percentage of the total allowance or token counts.

For unified X Pass subscriptions, Grok and Cursor display the same shared allowance
and product consumption. Each provider uses its own login: Cursor exchanges its login
for a short-lived commerce credential, used only in memory to read X Pass credits.
Product shares use a multicolor bar with names and percentages on hover or focus.
Zero shares retain a dot; unconsumed X Pass allowance uses a neutral segment.
Empty Claude Code history is hidden.
Product percentages are shares of the whole period allowance and are not normalized
to 100%. Third-party model quotas remain separate. Missing breakdown data is not
inferred from another provider's login. X Pass responses may round percentages, and
independent refreshes can observe different points in time.

## Token and dollar estimates

Codex, Claude Code and Antigravity history describes local device logs, not a complete account invoice.
Codex scans both plain `.jsonl` and Zstandard-compressed `.jsonl.zst` rollouts
in active and archived session folders, merging copies before counting usage.
Claude Code scans `projects/**/*.jsonl` under `CLAUDE_CONFIG_DIR` or `~/.claude`,
including subagents. Repeated message IDs are counted once using cumulative token
counts; cache reads and 5-minute/1-hour writes are priced separately. This does not
include Claude web chats, Cowork or activity on other devices.
Cursor history comes from its account export. Dollar values are API-equivalent USD
estimates, not subscription charges. Unknown prices preserve token counts but exclude
unpriced costs; refreshing prices can change historical estimates without changing tokens.

Price precedence is:

1. [OpenUsage supplement](https://robinebers.github.io/openusage/pricing_supplement.json):
   additional model rates, aliases and fast-tier multipliers.
2. [LiteLLM](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json).
3. [models.dev](https://models.dev/api.json).

Prices load from bundled data and local caches, with hourly background revalidation and
30-minute retries after a source failure. Failed downloads preserve cached prices.
A subsequent usage refresh reprices token records. Price requests transmit no account
credentials or usage records. OpenUsage-derived data and logic retain MIT attribution in
`shared/pricing/LICENSE.OpenUsage`. Implementation details are in [Development](development.md#subscription-development).

The header does not open hover details. When present, the warning/error icon opens
a secondary bubble containing the notices. Quota blocks and history rows use secondary
bubbles; native title tooltips are not used. Quota blocks share the usage-detail
animation and hover handling. These bubbles estimate the full-cycle API-equivalent USD value by dividing
observed cost since the inferred cycle start by the used quota fraction. The
cycle start is the reported reset time minus its window duration (including
5-hour, weekly and monthly windows). Timestamped history is retained for 32 days;
calendar-day history totals are not used for this calculation. The sample ends
at the earlier quota/history observation, with a maximum five-minute timestamp
skew. Estimates require at least 1% usage, a current unsaturated quota, and priced
tokens throughout the sample. Separate model quota pools are excluded when their
usage cannot be isolated. The secondary bubble contains the pace forecast, full-cycle
estimate and observed sample only. Incomplete logs, other devices, account switches,
early resets and changes in model mix can skew the estimate.
This is an inferred API-price equivalent, not a subscription balance or a promise
of future capacity.


Codex history and the native companion panels share the response-aware local collector. Legacy-only history remains explicitly incomplete. Account-window API-equivalent extrapolation is unavailable for device-local or incomplete history, and for stale quota/history snapshots; matching timestamps do not establish matching account coverage. See [native panel scope](plugin.md#scope-and-interpretation).

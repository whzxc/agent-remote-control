# Configure advanced settings with your Agent

**English** | [简体中文](../zh-CN/guides/settings.md)

Use **Settings** for task behavior, startup, notifications, language, light/dark appearance, macOS app placement, system permissions, and updates. Ask your own Agent to change specialized settings through CLI/AX. The commands below match the [CLI reference](../reference/cli.md#advanced-settings-through-cliax).

> Read the current settings in my ARC instance. Change only the values I request through CLI/AX, then read them back and report the result.

## Routing delay

Set the time before pending requests are forwarded to their control source. The range is 0–300 seconds; the default is 15. This does not approve requests.

```sh
arc cli call tasks.settings.get
printf '%s' '{"body":{"requestRoutingDelaySeconds":30}}' | arc cli call tasks.settings.set --stdin
arc cli call tasks.settings.get
```

## Proxy

Set an HTTP or HTTPS proxy for ARC. Read the current configuration first:

```sh
arc cli call network.get
printf '%s' '{"proxyMode":"custom","proxyUrl":"http://127.0.0.1:7890"}' | arc cli network --stdin
arc cli call network.get
```

For the system proxy, use the following command. For a direct connection, change `system` to `direct` and keep `proxyUrl` empty.

```sh
printf '%s' '{"proxyMode":"system","proxyUrl":""}' | arc cli network --stdin
```

New outbound requests use the saved proxy. Reconnect an existing connection when its running tunnel process needs the new proxy.

## Quota collection and refresh

Read the settings, then set `enabled` and `refreshMinutes`. This example enables collection with a five-minute refresh. Preserve the other current value when changing just one setting. Supported intervals are 1, 3, 5, and 10 minutes; the default is 3. Manual quota refresh remains in Agent details.

```sh
arc cli subscriptions get
printf '%s' '{"enabled":true,"refreshMinutes":5}' | arc cli subscriptions set --stdin
arc cli subscriptions get
```

## Display preferences

Read preferences and send only the keys you want to change. This example changes accent color and task bubble density:

```sh
arc cli call preferences.get
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"theme-color":"blue","task-bubble-density":"compact"}}}
JSON
arc cli call preferences.get
```

| Setting | Key | Values (default first) |
| --- | --- | --- |
| Accent color | `theme-color` | `arc`, `blue`, `purple`, `orange`, `green` |
| Bubble density | `task-bubble-density` | `standard`, `compact`, `detailed` |
| Bubble width | `task-bubble-width` | `medium`, `narrow`, `wide` |
| Compact bubbles automatically | `task-bubble-auto-compact` | `on`, `off` |
| Topology orientation | `topology-layout` | `auto`, `landscape`, `portrait` |
| Quota percentage | `quota-display` | `remaining`, `used` |
| Quota reset presentation | `quota-reset-display` | `countdown`, `time` |

For example:

```sh
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"topology-layout":"auto","task-bubble-width":"wide","task-bubble-auto-compact":"on","quota-display":"used","quota-reset-display":"time"}}}
JSON
```

## Maintainer mode

Maintainer mode enables development AX capabilities and is off by default. Set it back to `false` when finished:

```sh
arc cli config get
printf '%s' '{"maintainerMode":true}' | arc cli config set --stdin
arc cli config get
```

## Technical update policies

These policies accept `on` or `off`, defaulting to `on`. Send only requested keys:

- `update-accept-local`: allow local build replacement. Turning it off also blocks replacement from a local backup.
- `update-resume`: resume interrupted tasks after replacement.
- `update-control-scheduling`: let control sources schedule updates.

```sh
arc cli call preferences.get
arc cli call preferences.set --stdin <<'JSON'
{"body":{"values":{"update-accept-local":"off","update-resume":"on","update-control-scheduling":"on"}}}
JSON
arc cli call preferences.get
```

Release updates use the stable channel. Choose automatic or ask-first installation in Settings.

## Limits

Commands target the selected ARC instance. Use `arc cli --state-dir <absolute-directory>` when targeting another instance. CLI preferences appear after the next connector status refresh. The quota interval does not change account polling or the native quota cache. System consent still belongs to the operating system.

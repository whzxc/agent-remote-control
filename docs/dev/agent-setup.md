# Agent-driven installation and setup

## Responsibility and boundaries

Users should not need to understand public URLs, tunnels, OAuth, or OpenAI Platform to reach the first loop. A local Codex/Claude Code Agent executes and explains. The user chooses the route. Delegated signed-in page operations belong to the Agent. Assistance is needed only for missing login, challenges, passwords/2FA, payment, or the Agent's own safety policy.

ARC owns the flow, the Agent execution, and the user decisions. CLI output owns workflow knowledge rather than prompts or duplicated documentation. Agents loop over setup without reconstructing paths from GitHub docs. User steps require observable ARC completion signals. Wait for those signals rather than repeatedly asking whether the user finished.

setup is a thin onboarding/diagnostics layer, not a workflow engine. Add no DSL, plugin step registry, or rollback framework. Derive state from ingress/onboarding/verification/OAuth/permissions/login/task records. Persist only otherwise unavailable goal/choices/startedAt/dispatch receipt/thread link in one small state JSON. Keep exactly five step kinds. Reuse ingress validation. Secrets MUST NOT pass through chat or command-line arguments.

## Goals and step model

| Goal | Meaning | Recommendation |
| --- | --- | --- |
| claude-loop | Claude custom connector over HTTPS/OAuth plus Codex, including Claude Code cloud-session notifications. | Default recommendation. |
| chatgpt-chat | ChatGPT Chat using Secure Tunnel by default with HTTPS/OAuth fallback plus Codex. | Try directly. Offer fallback on actual permission failure. Custom MCP permission is still required. |

Without a chosen goal, setup next returns decide. Shared setup.option.<goal>.explain UI messages describe both routes and requirements. The App shows only the selected goal's explanation.

```json
{
  "schemaVersion":1,"goal":"claude-loop","progress":{"done":3,"total":8},"complete":false,
  "step":{"id":"choose-address","kind":"decide","title":"Choose a connection address",
    "explain":"Claude needs a public address to reach this computer. A temporary address needs no configuration but changes after ARC restarts and requires adding the connector again. A fixed address requires one-time setup.",
    "options":[{"id":"cf-quick","label":"Try a temporary address","recommended":true},{"id":"fixed","label":"Use a fixed address with a provider account"}],
    "apply":"setup apply choose-address --stdin {\"option\":\"cf-quick\"}",
    "openUrl":null,"doneWhen":"Address method saved","playbook":"choose-address"}
}
```

steps:[{id,title,kind,done}] is the full derived progress sequence, empty before goal selection. cliPath/stateDir identify the current instance for prompts. dispatch contains saved receipt/thread link or is empty before dispatch. next/apply/wait accept one --locale zh-CN|en, or body.locale, for user-facing explain/title/label/doneWhen without changing App preferences. These strings are localized for verbatim relay to the user. Model instructions and generated setup prompts are English only, with the user's locale retained as a parameter. No Chinese model-prompt copy is kept.

apply is the Agent command for auto/decide. openUrl is an HTTPS/deep link for authorize/remote-ui/secret. doneWhen describes the signal. playbook selects the shared skill section, also readable through cli setup playbook <id>.

| Kind | Owner and behavior |
| --- | --- |
| auto | Agent executes apply, then next. |
| decide | Relay explanation/options faithfully with recommendation. Apply after user selection. |
| authorize | Agent opens the URL and completes delegated signed-in operations, requesting help only for defined exceptions, then waits. |
| secret | Core receives clipboard data. Agent clicks the official Copy button and applies clipboard. Without Copy, the user copies manually. Existing forms are fallback. Agent never reads credentials/clipboard and then waits. |
| remote-ui | Agent follows the playbook with browser/computer use, or gives user guidance without tools. Same login/policy exceptions apply. Then wait. |

## CLI

```text
arc cli setup [next] [--goal claude-loop|chatgpt-chat]   # Read current step
arc cli setup apply <stepId> --stdin                   # Save choice or execute auto step
arc cli setup wait [--timeout <sec>]                   # Wait for completion or timeout, default 60s
arc cli setup playbook <id>                            # Print playbook
arc cli setup reset                                    # Clear goal/choices, retain ingresses
arc cli skill install --target codex|claude-code       # Install arc-setup skill
```

Catalog operations setup.next/apply/wait/dispatch also appear through cli mcp with existing JSON envelopes. next --goal previews only. choose-goal apply with option saves the goal and first startedAt. Repeating the same goal preserves time. Switching clears old choices.

Address selection and ChatGPT credential steps reuse/create a stopped ingress for the secret form. create-ingress starts/probes it. Fixed addresses choose Cloudflare login or another provider with existing forms. Readiness skips persist as choices. Skipping Claude Code makes loop-test check completion/ARC_ONBOARDING_OK and report unavailable notification capability.

verification.firstOAuthRequestAt records accepted DCR/authorize requests. firstMcpRequestAt records authenticated requests reaching MCP dispatch. lastProbe records time/URL/success. They reset with verification binding without an event history. `agent-remote-control://ingress?id=<ingressId>&field=<credentialField>` opens/focuses the connection editor. Permissions uses agent-remote-control://permissions. wait timeout is not an error and returns the same current step. Repeated apply reuses existing ingress without duplicate creation.

## Step sequences

### claude-loop

| ID | Kind | Derived completion signal |
| --- | --- | --- |
| codex-ready | auto/authorize | codex.login.status authenticated. Otherwise authorize with codex.login.open. |
| claude-code-ready | auto/authorize | Missing CLI returns official installCommand. Agent installs then applies. Installed but logged-out opens terminal login. Empty input is accepted. Existing doctor checks apply. Skipping disables notifications. |
| permissions | authorize | full-disk-access and applicable command-full-disk-access granted. Accessibility/Screen Recording/notifications are optional. Opens ARC Permissions & readiness. May skip. |
| choose-address | decide | Choice saved. |
| choose-provider | decide | Fixed route: Cloudflare recommended with a managed domain, or another provider. |
| cloudflare-login | authorize | Origin certificate ready in ARC state. |
| cloudflare-tunnel | auto | Hostname bound, tunnel ID/local credentials saved. |
| address-secret | secret | Other provider has required hasXxxToken. Custom reverse proxy checks address configuration. |
| create-ingress | auto | Ingress exists, runs, and passes probe. |
| add-connector | remote-ui | Ingress receives DCR/authorize and pending OAuth request. |
| consent | authorize | Valid ingress OAuth grant. |
| verify-connector | remote-ui | challengeVerifiedAt after setup start. |
| loop-test | remote-ui | Bound task completes and notification delivers, or completion plus notification failure finding. |

### chatgpt-chat

| ID | Kind | Completion signal |
| --- | --- | --- |
| codex-ready | auto/authorize | As above. |
| permissions | authorize | As above. |
| tunnel-credentials | remote-ui + secret | Platform Tunnel created. Agent may read/fill nonsecret Tunnel ID. Runtime key uses secret flow. Ingress has tunnelId/hasApiKey. |
| create-ingress | auto | Running ingress with successful control-plane polling. |
| enable-in-chatgpt | remote-ui | Any authenticated MCP request from that ingress. |
| verify-connector | remote-ui | As above. |
| loop-test | remote-ui | Completed task replies ARC_ONBOARDING_OK. |

Missing signals require only minimal observable fields, never another event system.

## Credentials

address-secret/tunnel-credentials apply accepts {"source":"clipboard"}. Core reads and extracts from raw credentials, common install commands, or JSON. Existing ingress update saves them before clipboard clearing. Results contain only hasXxx flags, never credentials or next. Empty clipboard with existing credentials is idempotently successful. Extraction/save failures retain clipboard and original errors without echoing contents. Agents then call next/wait.

Agents click official Copy without reading clipboard or secret-bearing DOM/screenshots. Without Copy, ask the user to copy. Existing forms/focus deep links remain fallback without a separate secret panel. Editors subscribe to ingress changes but update only unedited fields, so external domain updates appear without overwriting user input.

## arc-setup skill

skills/arc-setup/SKILL.md is English and ships in Resources. cli skill install copies it to ~/.codex/skills/arc-setup or ~/.claude/skills/arc-setup. It contains only the next → act by kind → next loop, authorization/secret/wait rules, and remote-page playbooks. Browser tools such as IAB operate directly. Computer use/ARC screen can navigate screenshots. Without either, provide a link and one-sentence guidance.

The flow stays in setup next. CLI playbooks and the skill share sources. macOS resources live in Contents/Resources/skills/arc-setup. Windows uses installed skills/arc-setup. Linux uses skills/arc-setup beside Core/tarball. Development falls back to repository resources when installed resources are absent. Installation replaces the target skill directory and removes old files.

Notification delivery.taskState stores native states such as completed. Setup never matches localized labels. Older records without taskState do not prove new completion. Permissions require disk access only. Other grants are user choices. Loop tests MUST originate in the remote conversation. The local Agent may send a prompt on the signed-in remote page but cannot substitute a directly created local task. Self-test dispatches MUST use purpose:self-test.

## App delegation

The first Add Source screen selects Claude/ChatGPT with Claude recommended. The primary action sends to Codex through Core using a generated English prompt and an automatically created setup-workspace in state. Native model/effort/owner defaults apply. Copy to another Agent is secondary and includes Claude Code skill installation when relevant. Every prompt pins current ARC_STATE_DIR. Manual configuration opens existing forms.

After sending, show progress, current step, and user-wait state with direct authorization buttons and native Codex task navigation. Decisions stay in the Agent conversation rather than duplicated App options. Installed/logged-out Codex shows login with the existing login.open flow and copy fallback. Missing Codex shows one copy-prompt primary action with official download guidance. Visible progress polls next every two seconds and pauses while hidden. decide/remote-ui directs conversation continuation. secret opens/focuses existing credential fields. Completion offers return-home.

Steps are one vertical list. Claude connector addition shows URL/copy directly. User-facing step text does not expose internal fields/commands/JSON. Fresh state no longer precreates a ChatGPT ingress. No ingresses/setup.json opens setup automatically. Incomplete setup.json opens progress. hasState reports file existence. Closing a panel prevents repeated auto-opening in the same window. Incomplete goals offer resume setup. Dispatched goals offer native task navigation.

setup.dispatch saves goal, installs Codex skill, creates workspace, and reuses native creation/persistent receipts. Explicit send authorizes the setup task. setup.json stores dispatch.requestId/threadId/desktopUrl. Repeat clicks read the same receipt without another thread. Failed/unconfirmed creation retains the receipt and returns error.

Generated prompts use shared/core/model-prompts.json in English. They identify goal/CLI/state, read protocol, and loop setup next with the user's locale. They require one resource/local-tool scope confirmation unless already given, then complete delegated signed-in operations without per-item reconfirmation. They faithfully relay localized decide options, respect login/challenge/password/2FA/payment/policy exceptions, use wait as completion evidence, and transfer secrets only through official Copy/Core clipboard.

## Documentation and delivery scope

README variants offer App delegation and a local-Agent prompt linking the public skill. Localized auto-setup guides explain App entry and user choices/login/credentials/remote testing. English reference/cli owns setup/skill/dispatch contracts. Getting Started leads with Agent setup while retaining manual paths.

Integrated scope includes setup commands/catalog, skill/install, App delegation/progress, macOS/Linux bootstrap, fixed-address login, direct clipboard receipt, Claude Code installation/login, and ChatGPT fallback. Temporary-address self-healing and Windows bootstrap remain future work. Keep required permissions limited to applicable disk access. The derived steps/CLI paths and dispatch metadata do not constitute another workflow state engine.

## Bootstrap

The skill is the single Agent entry point. Detect local App/CLI first. If absent, download/run the stable release install-agent-remote-control.sh, then install the current Agent's skill and enter setup. Do not maintain a separate installation prompt or mount a DMG.

macOS resolves the version through releases/latest redirect or ARC_VERSION without jq. Download agent-remote-control_<version>_<architecture>.app.tar.gz and verify SHA256SUMS.txt with system shasum. Missing Intel assets fail explicitly. Default location is /Applications/Agent Remote Control.app, with ARC_INSTALL_DIR selecting the parent. Same version skips download/replacement. Other versions quit the target App before replacing, remove quarantine, and open it. App/CLI share ARC_STATE_DIR.

New Agent installs create setup.json with empty choices, not a chosen goal, so App waits for the Agent. Existing setup is preserved. After Core is queryable, the final line returns version/cliPath/stateDir JSON for subsequent commands. Linux retains headless tarball/checksum/user-directory installation. Complete bootstrap requires matching installer script, setup CLI, skill resources, and first-launch UI in the release.

## Fixed-address login

Fixed addresses choose a provider. Cloudflare needs a hosted domain. Managed cloudflared login captures an authorization URL for delegated signed-in browser operation. Missing login requires user help. The URL stays in memory, not setup.json.

cloudflared login does not use origincert as output path. Give only that child isolated HOME/USERPROFILE, producing <stateDir>/cloudflare/.cloudflared/cert.pem. Later commands use TUNNEL_ORIGIN_CERT without changing the user's default cloudflared directory. ARC reads zone/account from the certificate, queries domains, and lists tunnels. Prefer an ingress-associated or arc-<short-hostname> locally managed tunnel. An already-routed default hostname may be reused only with ARC-owned credentials. Otherwise create and route DNS to arc-<short-hostname>.<zone> and explain the result.

Dashboard-managed same-name tunnels keep their routes. Use a -local suffix for local management. Never overwrite another service's DNS. cloudflareAuth is token/login, default token, plus cloudflareTunnelId. Login uses state-directory credentials/local ingress configuration. Token mode remains supported.

Missing Claude Code uses official Anthropic installation. ARC opens an interactive terminal for claude auth login. The Agent continues signed-in browser work. Missing login or authorization-code entry requires user help. Headless Linux uses the user's terminal. Explicit skip remains available. Only Cloudflare-native certificate/credentials/runtime config add persistent files. Five step kinds and ingress validation remain unchanged.

## ChatGPT permission failures and readiness

Setup handles released-window deep-link recreation, irrelevant clipboard text, and locally ready clients rejected by the control plane. Callback scheduling and field-shape checks handle the first two. Actual control-plane evidence handles rejection.

Do not ask speculative permission questions or probe internal APIs with local Codex/ChatGPT credentials. Default to Tunnel setup. Actual Platform rejection or missing custom MCP causes chatgpt-fallback apply with platform-denied/chatgpt-denied/runtime-key-rejected, saved as choices.chatgpt-blocked. next explains and offers https-oauth/retry. HTTPS keeps chatgpt-chat and reuses address/Cloudflare/probe/connector/consent. Retry clears the report. HTTPS avoids Platform Tunnel permission but not ChatGPT workspace restrictions. Tunnel fallback also exposes the decision for rejected keys.

Runtime API keys use restricted Tunnels Read + Use. Creating a Tunnel needs organization Read + Manage. Clipboard shape checks require OpenAI sk- and at least 32 characters, Cloudflare eyJ and at least 64, ngrok/LocalXpose at least 20, Pinggy at least 16. No remote credential probe is added. Failed extraction/save preserves clipboard.

/readyz proves startup only and may precede authentication. Core reads successful polling/HTTP status from local /health/control-plane into ingress.controlPlane. Explicit 401/403 client logs also produce RUNTIME_KEY_REJECTED. Setup returns to credentials with the reason and waits for authentication after replacement. Unknown health is not ready. Old clients lacking detailed health need updates.

## Desktop deep links

Tauri plugin event dispatch holds the plugin-list lock. Deep-link callbacks MUST NOT synchronously recreate a released WebView, which reacquires that lock. Queue a blocking worker so Apple Event returns before window work. run_on_main_thread may execute inline and is not a replacement.

An isolated reproduction closes setup and the main window, waits over 30 seconds for WebView release, then sends agent-remote-control://ingress?id=setup-chatgpt-chat&field=apiKey to that isolated App. Verify recreation and responsive editing, plus the route with an existing window. Do not use active production state.

## Client readiness and cleanup

OpenAI ingress startup checks the selected tunnel-client, minimum 0.0.16. Missing/old clients use existing official download/checksum/managed-state installation. Stop only the relevant ingress when necessary, switch the managed path, and restart without overwriting external user binaries. Repeated start checks versions even for running ingresses. Explicit dependency installation owns stop/start and supports ingress targeting.

Unknown versions and upgrade failure yield TUNNEL_VERSION_UNKNOWN/TUNNEL_UPGRADE_FAILED with reason/known/minimum versions. doctor and next share findings. Existing redaction protects client error summaries and next commands. Dependency failures take precedence over key diagnosis. cli help is a compact grouped index. capabilities/schema owns contracts. guide owns procedures. Setup apply/nextAction pins CLI/state. Auto steps include stdin JSON. Decisions remain user-owned.

Platform Tunnels associate with the target ChatGPT workspace. Verify the association in that workspace before enabling. Current health has no workspace-association field, so do not infer absence or add preflight APIs. Authenticated remote MCP requests prove enablement.

Skill/protocol/prompts require one scope explanation/confirmation after goal choice, reusing existing explicit authorization. ChatGPT scope includes Tunnel, restricted key, workspace association, and local tools. Claude scope includes Cloudflare tunnel/DNS, connector, ARC OAuth, and Claude Code installation. Later actions reuse that authorization subject to Agent policy and login/challenge/password/payment exceptions.

New runtime keys use arc-<tunnel-id>-runtime-<timestamp>, recording only names. After replacement, wait for new-key control-plane success before revoking an identifiable replaced ARC-created key. Leave unrelated/unknown-origin keys alone.

cli uninstall [--purge] remains local, outside remote MCP. Default moves to Trash. purge permanently deletes. Stop App/Core/login startup and remove current-instance state/managed dependencies/platform caches/install resources and both Agents' arc-setup. On macOS, reset the installed Desktop bundle's TCC grants before removal, including those attributed to Desktop for Core and arc-screen, and report reset failures. Remove historical ~/.local/bin/tunnel-client only with instance configuration/upgrade ownership evidence. Never uninstall independent Codex/Claude Code or remove cloud resources. Windows cleanup runs after CLI exit and returns a result file.

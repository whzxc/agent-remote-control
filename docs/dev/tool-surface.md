# Frozen tools and progressive disclosure

## Purpose

Control-source clients cache tool definitions within conversations. A server-side parameter change can conflict with a cached client schema. Connector permissions are also recorded per tool, so adding tools can require renewed authorization. A large permanent tool list increases context cost and selection errors. ARC keeps a small frozen tool surface and discloses changing capabilities through the live op catalog and guide.

Read/write separation lets clients classify queries as read-only. It does not replace op authorization. Guide examples make forwarding calls concrete. Client classifier behavior requires actual acceptance rather than speculative abstractions.

## Frozen surface

| Tool | Annotation | Purpose |
| --- | --- | --- |
| `guide` | readOnly | Control-source-specific loop/notify/review/approvals, op index, and examples. `op` returns a full inputSchema and example. |
| `query` | readOnly | Read-only op: `{op, args}`. |
| `act` | write | Write or mixed op: `{op, args, requestId?}`. |

query.args and act.args are permissive objects. The server validates the selected op's schema. act.requestId takes precedence over args.requestId and passes through to supported ops, including receipt. Omit it for unsupported ops.

Guide parameters are frozen as `{topic?, op?}` with op taking precedence. query and act retain the envelopes above. WRONG_TOOL identifies the correct entry point and example. Names and parameter structures MUST NOT change, including optional additions. All capability changes belong in ops and guide.

Op names include codex_create, codex_wait, read, and git. Follow-up calls use `{hint, via:"query"|"act", op, args}`. Without a suggested call, next contains only hint. readNext and notification follow-ups use the same via/op/args form.

readOnlyHint determines each op's tool. Mixed ops such as receipt, screen, mcp, and codex_thread always use act without action-level splitting. connector_verify is a write op. codex_call and codex_schema retain native protocol access as ops. Setup verification prompts include the complete act call.

Default/read-only/all/custom policies apply to ops. Disabled or locally unavailable ops are absent from guide and return OP_UNAVAILABLE for schema reads and calls. The three MCP tools remain available. Read-only policy retains connector_verify as a maintenance exception through act. Existing allowlists use op names. guide is also an always-available query op. No old-tool aliases are retained.

## Correction and versions

Op argument errors reuse the JSON Schema validator. Errors include a field path, a short reason, and a query guide call so the control source can correct the request without repeating the schema. Unknown ops return at most three nearby enabled names and direct the caller to guide. Renamed ops need no compatibility alias.

All tool results include arcVersion: the first 12 SHA-256 characters of the embedded catalog, including guides, schemas, examples, and exposure metadata. The control source MUST re-read guide when arcVersion changes. Objects receive the field directly. Arrays, scalars, and null become `{value,arcVersion}`. arcInbox is attached when unread events exist. This is a content version, not the application version. Local availability and policy changes require a fresh guide read without changing the catalog hash.

## Guide content

The default loop response includes core rules and common enabled ops. The query guide op accepts view:full for the complete source-specific workflow, examples, and enabled index. Existing notify/review/approvals topics retain detailed workflows. The compact guide points to these discovery paths. Full Claude examples include notify. Event contracts appear in the full view and notify topic.

Index signatures contain parameter names rather than duplicate orchestration examples. Required names are bare and optional names end in `?`. Limits come from the current schema. catalog.guideParameters chooses display order and important optional fields such as project, notify, latest, turnId, and expectedHash. Generation validates parameter existence and includes all required fields to prevent drift.

guide({op:"<name>"}) returns a full schema, description, signature, and example. Cached clients that reject op use query({op:"guide",args:{op:"<name>"}}). The query guide op also accepts topic, view, and knownGuideHash without changing the frozen tools. Hash the projected response before adding guideHash. A matching knownGuideHash returns unchanged:true instead of content. Source-specific limits, enabled ops, and configured context guidance participate in the hash. Only canonical parameters appear in signatures and advertised schemas; execution retains legacy argument normalization before defaults and receipt hashing.

Guides and all model-facing catalog text are English only. The top defines MUST, SHOULD, and MAY once. One sentence expresses one rule. [Terminology](terminology.md) owns the fixed vocabulary. User input and original evidence remain unchanged.

Keep index descriptions short. Individual ops retain complete descriptions. Maintain minimal examples beside schemas rather than generating speculative examples. MCP instructions direct callers to guide and query/act.

## Integration points

Keep control-loop documentation, reference/tools, localized user-guide examples, setup prompts, and bundled skills consistent with the tool envelopes. Transport wait limits identify the op. arcInbox, next, and read acknowledgement also identify ops. Settings displays op policies and permission state.

Use the existing validator rather than a second defensive layer. Existing tests may be migrated without new unit-test coverage. Acceptance scripts are permitted by repository conventions. The first release migrating an old tool surface requires a one-time client refresh and reauthorization notice. Subsequent capabilities use ops and guide.

## Acceptance

- tools/list returns only guide/query/act. Op exposure follows policy.
- A fresh Claude conversation reads guide, dispatches act codex_create with notify, receives [ARC], and reviews through query.
- Invalid arguments and unknown ops provide usable correction evidence.
- Guide changes alter arcVersion on tool results.
- Existing checks and tests pass.


## Profile projection

[Control profiles](control-profiles.md) specialize initial discovery through `toolExposure` preset metadata.
Profile selection never changes execution allowlists or runtime availability.
Existing sources remain Legacy until explicitly changed.
Local Code is restricted to built-in CLI authority; MCP sources use remote profiles.
Local Code Layer 1 targets 2,500 serialized-result Unicode characters including index and hashes.
The full view still exposes all policy-enabled operations.
Notification workflow prose is automatic only for push profiles.
Coordination, SRC, and context details use explicit query guide topics.
Per-op guides retain complete schemas and retry contracts.
The profile projection participates in `guideHash`.
Summary task views use operation args and retain the existing result envelopes.
Their final field allowlist excludes inbox and cross-thread state.

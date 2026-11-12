# Remaining Board composition work

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

[Coordination](coordination.md#desktop-board) owns the implemented Board, its Current, Activity and AX views, owner navigation and read-only boundary.

## Shared native attention projection

Task questions, permission requests, failed executions, connection faults and update attention are still composed in `ui/coordination/state.ts`.
Move these projections into a bounded native composition shared by authenticated sources and Desktop.
Reuse the existing task, interaction, connection and update owners.
Return canonical owner identities, required actors, observed state, coverage and schema-valid owner-detail actions.
Deduplicate the same requirement by canonical owner identity.
Keep missing, failed and partial reads distinct from genuine emptiness.
A successful successor may supersede predecessor attention without rewriting its historical outcome.
Reading MUST NOT acknowledge messages, advance Agent cursors, clear blockers, publish intent, resume tasks or create a second task store.
The Desktop remains read-only; explicit navigation opens the existing authorized owner surface and preserves Back context.

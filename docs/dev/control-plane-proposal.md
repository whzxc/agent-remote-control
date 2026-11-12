# Remaining control-plane work

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

[Current coordination contracts](coordination.md) own the implemented journal, bulletin, sessions, AX, messaging, recovery and local authority.

## Source-reported event claims

Direct authenticated publication of a source-reported event claim remains unimplemented.
The current catalog has no `event_report` operation.
A future claim operation MUST distinguish source-reported claims from ARC-observed facts.
It MUST retain authenticated attribution, bounded summaries, resource references and idempotent writes through the existing receipt owner.
A claim MUST NOT become evidence of execution, completion, clearance or delivery.
It MUST NOT copy prompts, transcripts, credentials or private routes into the shared journal.

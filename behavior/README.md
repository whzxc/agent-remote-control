# Behavior rules

Owner-approved behavior rules for ARC, one file per capability from `arch/agent-scenarios/capabilities.json`. The format is a draft under trial; see the Home proposal `proposals/behavior-spec-format.md`.

- `<capability>.json` holds the rules. `review` carries the owner-facing text the owner approved.
- `approved.json` locks each approved rule with a SHA-256 hash of the canonical JSON (sorted keys, no whitespace) of its `statement`, `given`, `when`, `then` and `review`. Only the control source writes it, after owner approval.
- `cases/<rule-id>/` holds generated acceptance cases. Each assertion cites the `then` ID it checks.

Implementation tasks MUST NOT edit rule files or `approved.json`. A rule that cannot be met as written goes back to the owner as a proposed change; it is not reworded to match the implementation.

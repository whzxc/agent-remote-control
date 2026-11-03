# Coding lanes

Use a lane only when the dispatching task explicitly assigns one. Create and manage
lanes through `npm run wt`; do not improvise a runnable environment in a lane.
A lane belongs to its assigned task. Never check out, commit from, clean or remove
another task's lane. After every lane commit, run `git show --stat HEAD` and confirm
it lists only your own files. While lanes are active, do all coding in assigned
lanes. Reserve the main checkout for `wt land` and acceptance.

From the main checkout, run `npm run wt -- create <name>`. This creates `wt/<name>`
from main HEAD at `<repository-parent>/<repository-name>.wt/<name>`.
`ARC_WORKTREE_ROOT` overrides the parent directory and must stay outside the repository.
The command clones matching Node dependencies with copy-on-write or runs `npm ci`,
allocates a private Rust target, and builds the frontend resources needed by Tauri.
It prepares both root and relay-worker dependencies. Never symlink node_modules.

If main's target is a symlink, the lane target is a sibling of its resolved destination,
named `<target-name>-wt-<name>`. Otherwise it lives in the lane. Copy-on-write seeding
is optional; unsupported filesystems start cold. Create lanes while main's build is
idle so the seed is stable. Each target has its own Cargo locks and cache budget.
`wt list` reports JSON with ahead/behind main, dirty state and combined dependency/target
disk bytes. Filesystem accounting can count shared copy-on-write blocks for each lane.

The control source creates the lane before dispatching. Pass its absolute path as
`codex_create.project`, then assign the module, lane path and allowed checks in the
prompt. Keep that task in the lane for edits, builds, type checks and commits.
`npm run check` and `npm run check:native` run there. ARC records the thread directory
and turn baseline there, so `codex_changes` reads that lane's changes. `root` only
selects an existing project root; it does not attach an arbitrary external lane to
the main project. ARC's disk permissions must allow the lane directory. An unregistered
lane supplies cwd without a native projectId; ARC does not register it as a project.

Commit the lane changes, inspect `git show --stat HEAD`, then run
`npm run wt -- land <name>` from main. The lane must be clean and main must have
`main` checked out. Landing refuses if main has staged, unstaged or untracked changes
in files touched by incoming commits and lists those files. It leaves unrelated main
changes to Git's merge checks. Landing rebases the lane on main, then merges with
`--ff-only`; it never pushes. If rebase conflicts,
resolve the listed files in the lane and run `git rebase --continue`, or abort with
`git rebase --abort`. Retry landing after resolving. Land one lane at a time.

Run the app, `dev`, `dev:isolated`, installs, desktop packaging, releases and all
acceptance serially in main after landing. The shared tooling guard makes npm dev,
packaging, release, acceptance and Vite dev entry points refuse in a lane and name
main. Installed products and the published installer contain no lane guard.
The marker belongs only to the lane checkout; keep it until the lane is removed.

`check:native`, `desktop:check`, `test` and `desktop:build` share one machine-wide
queue across main and all lanes. The full native-check lifecycle holds the lock.
A waiter reports the holder's checkout and command once before waiting. The lock
lives in the user's cache and uses Rust's native file locking; process exit releases
it, so leftover lock files do not block later commands. Nested build steps share the
same lock. Light checks (`check`, `check:format`, `check:tests`) run without it.

After acceptance, run `npm run wt -- remove <name>` from main to delete the worktree,
its private target and branch. Unmerged branches and dirty worktrees are retained
unless `--force` is supplied. A failed create leaves its lane registered for repair
or removal with the same command. Do not manually delete the worktree or its target.


Successful create, land and remove commands report lifecycle metadata to an already
running Core through bounded local management and verify the stored transition.
The parent must be a registered project. A missing Core or failed/partial command
prints `coordination-observation` with `coverage:missing`; the original command result
is unchanged. A bounded outbox under the main Git directory retains completed
reports for later reconciliation with the same transition IDs. Ref movement alone
never implies that a land command ran. See [Coordination](coordination.md).

Land preflight prints `coordination-conflicts` from the shared board when the running
Core can map the registered parent. Lifecycle readback also returns current advisory
conflicts and activity ages. Unknown coverage is explicit. Warnings never bypass the
main-only guard or block an otherwise authorized action; pull `board` before landing.

Lifecycle warnings exclude notices owned by the command initiator when Core verifies
the opaque origin token injected into its command child environment. Core retains
the verified source with the observed transition for readback. Manual commands and
unrecognized tokens keep all overlapping notices.

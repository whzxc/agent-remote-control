# Arc.TaskNode

Real TASK adapter. Requires [Arc.Root](Root.md). Records use existing UI types; no stores, live reads or mutations are created by the mount. Identity privacy follows Root; task content retains its existing sensitivity rules. All design-island content slots accept plain text only.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `agent / session / now` | `string / TrackedActivity / number; required` | Agent identity, recorded activity and fixed epoch milliseconds. |
| `density / blocking / selected / disabled` | `compact \| standard \| detailed / boolean / boolean / boolean` | Existing task densities, blocking request and selection states. |
| `onOpen / onRead` | `callback / callback` | Open and mark-read are required independent actions. |

## Mounting

Pass typed synthetic records from [Arc.fixtures](fixtures.md) (`Arc.fixtures.tasks`) and stub callbacks through named `renderVals` holes. Copy records before changing states. The preview runs in light and dark through Root. Native navigation, decisions and lifecycle belong to the embedding host.

Use `Arc.fixtures.tasks.now` for Root and any explicit `now` prop to keep recorded timestamps aligned.

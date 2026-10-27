# Arc.SrcAccountNode

Real SRC/TUNNEL object adapter. Requires [Arc.Root](Root.md). Records use existing UI types; no stores, live reads or mutations are created by the mount. Privacy follows Root. All design-island content slots accept plain text only.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `product / state` | string / WireState; required | Artwork and projected connection state. |
| `account / sourceLabel` | Pick<ProviderAccount, "alias"> / string | Resolved alias or explicit source label. |
| `suffix` | string | Host-supplied stable Unidentified suffix. |
| `onOpen` | callback | Open the account panel. |
| `selected / newlyAdded / labelContent` | boolean / string | Host states; optional plain-text label slot. |

`candidateLabel` optionally supplies the short visible name. The full platform and account identity stays in the accessible name and tooltip.

## Mounting

Pass typed synthetic records from `Arc.fixtures` and stub callbacks through named `renderVals` holes. Use `Arc.fixtures.tunnelFrames` for TunnelNode. Missing optional facts are omitted or shown as unknown; historical references never acquire live state. Native editing, navigation and approval belong to the embedding host.

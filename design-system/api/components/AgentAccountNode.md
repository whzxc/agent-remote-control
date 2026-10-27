# Arc.AgentAccountNode

Real AGENT adapter. Requires [Arc.Root](Root.md). Records use existing UI types; no stores, live reads or mutations are created by the mount. Privacy follows Root. All design-island content slots accept plain text only.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `account / agent / state` | `Pick<ProviderAccount, "alias" \| "quota"> / string / WireState; required` | Identity, Agent brand, existing quota ring and wire state. |
| `platformLabel / suffix / selected` | `string / string / boolean` | Platform context, optional suffix and selection. |
| `onOpen` | `callback; required` | Host navigation. |

`candidateLabel` optionally supplies the short visible name. The full platform and account identity stays in the accessible name and tooltip.

## Mounting

Pass typed synthetic records from [Arc.fixtures](fixtures.md) (`Arc.fixtures.agentObjects`) and stub callbacks through named `renderVals` holes. Copy records before changing states. The preview runs in light and dark through Root. Native navigation, decisions and lifecycle belong to the embedding host.

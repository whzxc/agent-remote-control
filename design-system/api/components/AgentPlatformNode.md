# Arc.AgentPlatformNode

Real AGENT adapter. Requires [Arc.Root](Root.md). Records use existing UI types; no stores, live reads or mutations are created by the mount. Privacy follows Root. All design-island content slots accept plain text only.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `agent / state / quota` | `Agent / WireState / ProviderAccount["quota"] \| null` | Required inventory record and wire state; optional account quota for the existing ring. |
| `label / selected / children` | `string / boolean / string` | Accessible label, selection and plain-text content. |
| `onOpen` | `callback; required` | Host navigation. |

## Mounting

Pass typed synthetic records from [Arc.fixtures](fixtures.md) (`Arc.fixtures.agentObjects`) and stub callbacks through named `renderVals` holes. Copy records before changing states. The preview runs in light and dark through Root. Native navigation, decisions and lifecycle belong to the embedding host.

# Arc.ActivityBubble

The existing task bubble with its original phase, headline, source badge and specification rendering.

Requires [Arc.Root](Root.md). Non-string props use template holes.

## Props

| Prop | Type / allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | `string` | `required` | Owning Agent ID. |
| `session` | `TrackedActivity` | `required` | AgentActivitySession plus orderAt and optional endedAt/readAt/status; see fixtures. |
| `now` | `number` | `Root.now` | Epoch milliseconds; override only to compare clocks. |
| `density` | `"compact" &#124; "standard" &#124; "detailed"` | `"standard"` | Height comes from the real bubbleHeights model; host can set --bubble-width. |
| `onRead` | `() => void` | `required` | Marks completed unread activity when the owner updates the record. |

See [fixture types](fixtures.md) and the current application types for full record fields.

## States

Running, needs attention, completed, unread, cancelled/interrupted and external transcript; compact/standard/detailed. Click emits arc:action with kind=selectAgentPanel. Local activity/update stores contain synthetic fixtures only.

## Canvas example

Values for the canvas `renderVals`:

```js
const renderVals = {
  agent: Arc.fixtures.activitySessions[0].agent,
  session: Arc.fixtures.activitySessions[0],
  read: () => {},
};
```

```html
<x-import component-from-global-scope="Arc.ActivityBubble" agent="{{agent}}" session="{{session}}" density="detailed" on-read="{{read}}"></x-import>
```

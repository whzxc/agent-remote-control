# Arc.GraphNode

The existing topology node button. This first island API allows plain text content only.

Requires [Arc.Root](Root.md). Non-string props use template holes.

## Props

| Prop | Type / allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `label` | `string` | `required` | Accessible name. |
| `state` | `"normal" &#124; "connecting" &#124; "error" &#124; "inactive"` | `required` | Existing WireState. |
| `onOpen` | `() => void` | `required` | Activation callback. |
| `highlighted` | `boolean` | `false` | Selected/highlighted presentation. |
| `newlyAdded` | `boolean` | `false` | New-source presentation. |
| `children` | `string` | `required` | Plain text node content. Nested x-import/React elements are not supported inside this island. |

## States

Normal, connecting, error, inactive, highlighted, newly added, keyboard focus and reorder. Surrounding topology geometry and panels remain owned by the artboard.

## Canvas example

Values for the canvas `renderVals`:

```js
const renderVals = {
  label: Arc.fixtures.sources[0].label,
  open: () => {},
  move: by => {},
};
```

```html
<x-import component-from-global-scope="Arc.GraphNode" label="{{label}}" state="normal" on-open="{{open}}" on-move="{{move}}">C</x-import>
```

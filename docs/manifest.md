# Layer manifest

A style is a folder that holds one `manifest.json` and the layer images it names. The manifest tells the builder what a user can pick and tells the render check what each layer is allowed to do.

[`fixtures/shapes/manifest.json`](../fixtures/shapes/manifest.json) is a complete example.

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Format version. It is `1`. |
| `style` | string | Id of the style: lowercase letters, digits and hyphens, starting with a letter. |
| `name` | string | Name shown to the user. |
| `canvas.width`, `canvas.height` | positive integers | Size of the picture in pixels. A layer image has to be this exact size, so layers line up without offsets. |
| `canvas.opaque` | boolean, optional | When `true`, a finished picture may not have see-through pixels. |
| `groups` | array | Trait groups in draw order. The first group is drawn first and sits at the bottom. |

## Groups

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique id, same character rules as `style`. |
| `label` | string | Name shown next to the picker. |
| `optional` | boolean, optional | When `true`, the user can leave the group empty. |
| `base` | boolean, optional | When `true`, any group drawn later may cover this one. Backgrounds and bodies are base groups. |
| `bleed` | array, optional | Canvas edges this group may touch: `top`, `right`, `bottom`, `left`. A layer that touches an edge its group does not list counts as clipped. |
| `zone` | object, optional | `{ "x", "y", "width", "height" }` in pixels. The group's layers have to stay inside this rectangle. |
| `over` | array, optional | Ids of earlier groups this group may cover, for example a hat that sits over the eyes. |
| `options` | array | The choices in the group, at least one. |

Two groups that are not base groups may only share pixels when the later one lists the earlier one in `over`.

## Options

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the group. |
| `label` | string | Name shown in the picker. |
| `src` | string | Path of the layer image, relative to the manifest. It has to stay inside the style folder. |

## Selections

A selection maps each group id to an option id, or to `null` for an empty optional group:

```json
{ "background": "blue", "body": "round", "eyes": "dots", "mouth": "line", "headwear": null }
```

`resolveSelection(manifest, selection)` in [`src/manifest.js`](../src/manifest.js) turns a selection into the list of layers to draw, bottom first.

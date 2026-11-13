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
| `id` | string | Unique id, same character rules as `style`. The builder shows the options of the group with the id `background` as swatches next to the preview, and every other group as a tab. |
| `label` | string | Name of the group's tab and the heading above its thumbnails. A screen reader reads it for the background swatches. |
| `optional` | boolean, optional | When `true`, the user can leave the group empty. |
| `base` | boolean, optional | When `true`, any group drawn later may cover this one. Backgrounds and bodies are base groups. |
| `bleed` | array, optional | Canvas edges this group may touch: `top`, `right`, `bottom`, `left`. A layer that touches an edge its group does not list counts as clipped. |
| `zone` | object, optional | `{ "x", "y", "width", "height" }` in pixels. The group's layers have to stay inside this rectangle. |
| `over` | array, optional | Ids of earlier groups this group may cover, for example a hat that sits over the eyes. The builder leaves this group's layer out of the thumbnails of each group it lists. |
| `options` | array | The choices in the group, at least one. A group with one option that isn't `optional` gives the user nothing to pick: the builder shows no thumbnails and no Lock for it, and Randomize keeps it. Its layer is still drawn. |

Two groups that are not base groups may only share pixels when the later one lists the earlier one in `over`.

The builder uses `over` for its thumbnails too. A thumbnail of a group's option draws the picked layers of each other group except the groups whose `over` lists it. With `"over": ["eyes"]` on Headwear, each Eyes thumbnail shows the eyes with no hat. The preview and the downloaded picture draw every picked layer.

## Options

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the group. |
| `label` | string | Name of the option's thumbnail: a screen reader reads it and it shows when the pointer rests on the thumbnail. |
| `src` | string | Path of the layer image, relative to the manifest, with forward slashes. Each part of the path may use letters, digits, hyphens, underscores and dots, and may not start with a dot. A path cannot leave the style folder. |

## Selections

A selection maps each group id to an option id, or to `null` for an empty optional group:

```json
{ "background": "blue", "body": "round", "eyes": "dots", "mouth": "line", "headwear": null }
```

`resolveSelection(manifest, selection)` in [`src/manifest.js`](../src/manifest.js) turns a selection into the list of layers to draw, bottom first.

# Render check

The render check reads a style's manifest and layer images and reports anything that would make a finished picture look wrong. A style has to pass before its layers go into the builder.

```sh
node bin/render-check.js fixtures/shapes/manifest.json
```

```
Style: fixture-shapes
Layers checked: 10
Layer pairs checked: 12
Combinations checked: all 48, 0 failed
Render check passed.
```

The command exits with 0 when the style passes, 1 when it found issues and 2 when it could not run (bad arguments or an unreadable manifest).

## What it checks

It works in three steps.

**Each layer on its own**

| Issue | Meaning |
| --- | --- |
| `missing` | The image could not be loaded. |
| `size` | The image is not the size of the canvas. Layers are full-canvas images, so a different size means the layer would not line up. |
| `empty` | The image has no drawn pixels. |
| `clip` | The layer touches a canvas edge that its group does not list in `bleed`, so the drawing is cut off there. |
| `zone` | The layer draws outside its group's `zone`. |

**Each pair of layers from two different groups**

| Issue | Meaning |
| --- | --- |
| `overlap` | The two layers share pixels and the manifest does not allow it. A pair is allowed when the lower group is a `base` group or the upper group lists the lower one in `over`. |

**Each combination a user can pick**

The check composites the combination with the same `compositeLayers` function the builder page uses.

| Issue | Meaning |
| --- | --- |
| `hole` | The finished picture has see-through pixels and the manifest sets `canvas.opaque` to `true`. |

The summary line counts a combination as failed when it has a hole or uses a layer or a pair that failed an earlier step.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--max-combinations <n>` | 2000 | The check visits every combination up to this many. Above it, the check visits a random sample of this many different combinations. |
| `--seed <n>` | 1 | Seed for the sample, so a failing run can be repeated. |
| `--json` | off | Print the full report as JSON. `combinations.total` is `null` when the style allows more combinations than a number can count exactly (above 2^53). |

`checkManifest` in [`src/render-check.js`](../src/render-check.js) also takes `alphaThreshold` (a pixel counts as drawn from this alpha value up, default 16) and `overlapTolerance` (shared pixels allowed per pair, default 0).

## Limits

- The check compares pixel coverage. It does not judge how a combination looks.
- Layers and pairs are always checked in full. Only the hole check depends on the combination sample, so a style with more combinations than `--max-combinations` can hide a hole in a combination the sample did not visit.
- Zones are rectangles.
- The check and the builder page read layer pixels in different ways. The check decodes the PNG file. The page reads pixels back from a canvas, which stores colour multiplied by alpha. Alpha values and opaque pixels are the same in both. The colour of a see-through pixel can differ by a few levels in the page: in Chrome a pixel of red 200 comes back as 199 at alpha 128 and as 204 at alpha 10. Every check here counts drawn pixels by alpha and never reads colour, so its results hold for what the page draws.

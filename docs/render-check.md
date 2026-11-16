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

## Broken on purpose

`npm run check:broken` shows that the check catches each way a layer can go wrong. [`fixtures/break-fixtures.js`](../fixtures/break-fixtures.js) makes broken copies of `fixtures/shapes` and `fixtures/blocks` in memory and writes no files. Each copy breaks one layer in one way, and each option layer gets each way that applies to its group:

- **Clipped**: moved past each canvas edge its group doesn't list in `bleed`. Expected issue: `clip`.
- **Off its anchor**: moved up, down, left and right until part of it sits 2 px outside its group's `zone`. Expected issue: `zone`.
- **Into another trait's area**: grown until it shares pixels with a layer of a group the check compares it with. Expected issue: `overlap`.
- **Hole**: a 3x3 px see-through patch cut in a layer of the bottom group, where no other group draws, when `canvas.opaque` is `true`. Expected issue: `hole`.
- **Wrong canvas size**: saved 4 px bigger and 4 px smaller than the canvas. Expected issue: `size`.

A copy counts as caught when the check fails it and reports the issue it was made to cause. Other issues on the same copy are fine. The command also checks both clean styles.

```sh
npm run check:broken
```

```
Clipped (clip): 52 copies made, 52 caught
Off its anchor (zone): 40 copies made, 40 caught
Into another trait's area (overlap): 10 copies made, 10 caught
Hole (hole): 4 copies made, 4 caught
Wrong canvas size (size): 36 copies made, 36 caught
Broken styles caught: 142 of 142. Clean styles passed: 2 of 2.
```

It exits with 0 when each copy is caught and both clean styles pass, 1 when a copy is missed or a clean style fails, and 2 when it could not run. A missed copy or a failed clean style gets its own line above the summary.

## Limits

- The check compares pixel coverage. It does not judge how a combination looks.
- Layers and pairs are always checked in full. Only the hole check depends on the combination sample, so a style with more combinations than `--max-combinations` can hide a hole in a combination the sample did not visit.
- Zones are rectangles.
- The check and the builder page read layer pixels in different ways. The check decodes the PNG file. The page reads pixels back from a canvas, which stores colour multiplied by alpha. Alpha values and opaque pixels are the same in both. The colour of a see-through pixel can differ by a few levels in the page: in Chrome a pixel of red 200 comes back as 199 at alpha 128 and as 204 at alpha 10. Every check here counts drawn pixels by alpha and never reads colour, so its results hold for what the page draws.

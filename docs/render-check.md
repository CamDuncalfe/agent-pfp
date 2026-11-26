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

It works in four steps.

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

The check also makes each file Download can save from that picture, the way the builder page makes it: each size `sizesFor` in [`src/download.js`](../src/download.js) offers, through `planDownload` and `pictureToSave`. A style with a square canvas of 500 px or more offers Full size and GitHub (500 x 500). The GitHub file is the finished picture scaled down with `scaleDown`.

| Issue | Meaning |
| --- | --- |
| `download` | A file Download would save is not the size asked for, or, when the manifest sets `canvas.opaque` to `true`, a scaled copy has see-through pixels. The message names the size, the file name and the combination. Full size saves the finished picture itself, so its see-through pixels are a `hole`. |

When a style offers more than one size, the report has a line under the combinations that names the sizes checked on each one:

```
Combinations checked: all 1800, 0 failed
Download sizes checked on each: Full size, GitHub (500 x 500)
```

When the check samples, the line says the sizes were checked on the sampled combinations only:

```
Combinations checked: a sample of 2000 different ones out of 648000, 0 failed
Download sizes checked on each sampled combination: Full size, GitHub (500 x 500)
```

The summary line counts a combination as failed when it has a hole or a download issue, or uses a layer or a pair that failed an earlier step.

**Each see-through option**

An option with `"seeThrough": true` is meant to show what is under it, like clear glasses over the eyes. For each such option, the check draws it over each option of each group that its group lists in `over`, with the default pick for every other group: the first option, or None for an optional group. It compares each picture with the same picture over that group's default option.

| Issue | Meaning |
| --- | --- |
| `covered` | Over the see-through option, an option of a covered group gives the same picture as the group's default option. The message names the see-through option and both options. The layer most likely paints its own picture over the group. |

Options that aren't marked see-through are not compared. A picture with a layer that could not be loaded or has the wrong size is skipped, because that layer is reported already. The summary line does not count these pictures as combinations.

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

It exits with 0 when each copy is caught and both clean styles pass, and with 1 when a copy is missed or a clean style fails. A clean style also fails when its manifest or a layer can't be read, and it gets no broken copies then. It also exits with 1, and says it could not run, when it gets an argument or `fixtures/index.json` is missing or not valid. Unlike the render check, it has no exit code 2. A missed copy or a failed clean style gets its own line above the summary.

## Limits

- The check compares pixel coverage. It does not judge how a combination looks.
- Layers and pairs are always checked in full. The hole check and the download check depend on the combination sample, so a style with more combinations than `--max-combinations` can hide a hole, or a bad file at a download size, in a combination the sample did not visit.
- Zones are rectangles.
- The check and the builder page read layer pixels in different ways. The check decodes the PNG file. The page reads pixels back from a canvas, which stores colour multiplied by alpha. Alpha values and opaque pixels are the same in both. The colour of a see-through pixel can differ by a few levels in the page: in Chrome a pixel of red 200 comes back as 199 at alpha 128 and as 204 at alpha 10. Every check but `covered` counts drawn pixels by alpha and never reads colour, so its results hold for what the page draws. The `covered` check compares the full colour of two decoded pictures. Two pictures that are the same in the check are the same in the page. Two that differ only by a few colour levels in see-through pixels could come out the same in the page.
- The `covered` check draws every picture it compares, and `--max-combinations` does not cap them. A see-through option with N covered options costs N + 1 pictures per covered group. The layers drawn before a covered group are composited once for that group, so each picture only draws the covered option and the layers above it.
- The `covered` check only draws the default picks for the groups it doesn't compare. A later group whose default covers the same pixels would hide the difference too.

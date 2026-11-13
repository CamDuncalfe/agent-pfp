# Agent PFP

Try it: https://camduncalfe.github.io/agent-pfp/

Agent PFP is a builder for coding-agent profile pictures. You pick an art style, choose one layer in each trait group (body, eyes, headwear and so on), hit randomize if you want a surprise, and download the picture.

Each style is a fixed set of layers prepared ahead of time. The app does not generate images.

I'm building it during the [Qodo Software Factory Hackathon](https://hackathon.qodo.ai/). Coding agents write the code and Qodo reviews each pull request before I merge it.

![The builder page showing the alien in a cowboy hat, heart shades and a purple hoodie](docs/img/builder.png)

The alien in the screenshot is the first style I've made. Its layers are in [styles/alien/](styles/alien/), and the builder opens on it. I own the artwork, and no license on the code covers it. [styles/alien/NOTICE.md](styles/alien/NOTICE.md) says what you can do with it.

## What works today

- A manifest format that describes one style: the canvas size, the trait groups in draw order and the options in each group. It is documented in [docs/manifest.md](docs/manifest.md).
- `validateManifest` in [src/manifest.js](src/manifest.js), which checks a manifest and lists what is wrong with it.
- `compositeLayers` in [src/composite.js](src/composite.js), which draws the layers of a selection into one picture.
- A render check that fails a style when a layer is the wrong size, blank, cut off by a canvas edge, outside its zone or overlapping another group, or when a finished picture has a hole. It is documented in [docs/render-check.md](docs/render-check.md).
- A builder page with one large preview of the picture and downloads it as a PNG. The background group's options are round swatches in a column on the left of the preview, with its Lock under them. The panel next to the preview has tabs. The first is Character: one tile per style in the style index, each showing the picture the style opens with, and picking one loads that style's manifest. The page opens on it when there is more than one style, and on the first trait tab otherwise. Each other group with something to pick is a tab after it, with the name of its pick and its Lock above a grid of thumbnails. When the panel is too narrow for the tabs in one row, they wrap as pills. [src/builder-layout.js](src/builder-layout.js) decides which group goes where.
  - Each thumbnail is the current picture with that option swapped in, zoomed in on the part its layer draws in: a square around the layer with some room, at most 60% of the canvas's shorter side, and 1.5 times as deep as a layer that runs off an edge of the canvas, so a Clothes tile shows the torso. A layer that covers the whole canvas, like a background colour, shows on its own. A thumbnail leaves out the layers of each group that the manifest says goes over its group (`over`), so the Eyes tiles show the eyes with no eyewear or headwear and the Eyewear tiles show no headwear. The preview and the download still draw every picked layer. [src/thumbnails.js](src/thumbnails.js) draws the thumbnails, in a worker ([web/thumbnail-worker.js](web/thumbnail-worker.js)) so the page keeps answering while they draw. The page and the worker read layers through [web/layers.js](web/layers.js) and keep the decoded ones up to a size limit set in [src/layer-cache.js](src/layer-cache.js).
  - An optional group's grid starts with a None tile. A group with one option and no None, like the alien's Character, gets no tiles and no Lock, and Randomize keeps it. Its layer is still in the picture.
  - Under the preview are Randomize, Download image and Reset. Randomize picks again in each group whose Lock is off. Reset puts each group back on its first tile, the one the page opens with, and turns each Lock off. When the picture changes it settles into place with a short soft scale, and Randomize sends a few stars out from the preview. With reduced motion on, nothing moves.
  - A Circle switch on the preview shows the picture the way GitHub shows a profile picture: the circle in the middle square of the picture. [src/round-preview.js](src/round-preview.js) describes the square.
  - When the style offers more than one size, a Size picker under the buttons offers Full size, which is the style's canvas, and GitHub (500 x 500), which is the finished picture scaled down. A style whose canvas isn't square or is smaller than 500 px offers Full size only, and the page shows no picker for it. The file is named `agent-pfp-<style id>.png`, or `agent-pfp-<style id>-500.png` for the GitHub size. The sizes are decided in [src/download.js](src/download.js) and the scaling is in [src/scale.js](src/scale.js).
  - On a page 900 px wide or more, the preview, its swatches and its buttons stay on screen while the panel scrolls. Under that the page is one column, and it works at 390 px wide. The type comes from Adobe Fonts through LayerTwo's subscription, loaded by one kit from `use.typekit.net` in [web/index.html](web/index.html): Owners Narrow Bold for the wordmark and the headings, and Neue Haas Grotesk Text for everything else. The system face stands in until the kit loads. The wordmark is the logo. The name in it and in the page title is written once, in [src/brand.js](src/brand.js).
- A style index, [styles/index.json](styles/index.json), that lists the styles the builder offers. It is documented in [docs/styles.md](docs/styles.md).

The alien in `styles/alien/` is the one style with real artwork, and the one the builder offers. The files under `fixtures/` are plain shapes used as test data. [fixtures/index.json](fixtures/index.json) lists the fixture styles that pass the render check, and the builder doesn't offer them.

## Run it

You need Node 22 or newer.

```sh
npm ci
npm test         # unit tests
npm run check    # render check on each style in styles/index.json and fixtures/index.json
npm start        # builder page at http://127.0.0.1:4173/web/
```

To build the builder as a static site for GitHub Pages, run `npm run build:site`. It empties `_site/` and writes the builder page, its code, `styles/index.json` and the manifests and layers that index lists there. `_site/index.html` takes you to the builder, and each link in the site is relative, so it works from a sub-path like `https://camduncalfe.github.io/agent-pfp/`. The build exits with 1 and says what is wrong when the index or a manifest isn't valid or a file it names is missing. [docs/styles.md](docs/styles.md#the-static-site) has the details. After each merge to `main`, the Pages workflow in [.github/workflows/pages.yml](.github/workflows/pages.yml) runs `npm test` and `npm run check`, and only when both pass does it build the site and deploy it to that address.

To check another style, pass its manifest: `node bin/render-check.js path/to/manifest.json`.

To look at a style that isn't in this repository yet, start the server with the folder that holds its style folder: `npm start -- --styles ../my-styles`. The Character tab shows it as a tile with "(local)" after its name. [docs/styles.md](docs/styles.md) has the details.

## Layout

| Path | What it holds |
| --- | --- |
| `src/` | Code shared by the builder page and the command line tools |
| `web/` | The builder page |
| `bin/` | Command line tools |
| `styles/` | The style index the builder reads, and the alien's manifest and layers |
| `fixtures/` | Test data: manifests, plain-shape layers and an index of the fixture styles |
| `factory/` | The runner that starts the coding agent on a ticket with the `ready-for-agent` label, see [docs/factory.md](docs/factory.md) |
| `docs/` | Format and runner documentation |
| `test/` | Unit tests, run with `node --test` |
| `AGENTS.md` | Setup, checks and house rules for the coding agents and reviewers |

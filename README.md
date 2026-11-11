# Agent PFP

Agent PFP is a builder for coding-agent profile pictures. You pick an art style, choose one layer in each trait group (body, eyes, headwear and so on), hit randomize if you want a surprise, and download the picture.

Each style is a fixed set of layers prepared ahead of time. The app does not generate images.

I'm building it during the [Qodo Software Factory Hackathon](https://hackathon.qodo.ai/). Coding agents write the code and Qodo reviews each pull request before I merge it.

## What works today

- A manifest format that describes one style: the canvas size, the trait groups in draw order and the options in each group. It is documented in [docs/manifest.md](docs/manifest.md).
- `validateManifest` in [src/manifest.js](src/manifest.js), which checks a manifest and lists what is wrong with it.
- A builder page that loads a manifest, shows one picker per group and lists the layers for the current selection.

No artwork is in this repository yet. The files under `fixtures/` are plain shapes used as test data.

## Run it

You need Node 22 or newer.

```sh
npm ci
npm test     # unit tests
npm start    # builder page at http://127.0.0.1:4173/web/
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/` | Code shared by the builder page and the command line tools |
| `web/` | The builder page |
| `bin/` | Command line tools |
| `fixtures/` | Test data: manifests and plain-shape layers |
| `docs/` | Format documentation |
| `test/` | Unit tests, run with `node --test` |

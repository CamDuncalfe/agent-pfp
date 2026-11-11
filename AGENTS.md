# AGENTS.md

Instructions for the coding agents and reviewers that work in this repository.

## The project

Agent PFP is a builder for coding-agent profile pictures. A user picks an art style, chooses one layer in each trait group (background, clothes, mouth, eyes, eyewear, headwear) and downloads the picture. I draw and cut the layers for each style ahead of time. The app stacks them and never generates an image.

A style is a folder with a `manifest.json` and the layer images it names. [docs/manifest.md](docs/manifest.md) describes the format. The render check reads a style and fails it when a layer is the wrong size, blank, cut off by a canvas edge, outside its zone or overlapping another group. [docs/render-check.md](docs/render-check.md) lists each failure.

## Setup

You need Node 22 or newer.

```sh
npm ci
```

## Check your work

Run these before you open a pull request. CI runs the first two again on the pull request.

```sh
npm test         # unit tests (node --test), all of them have to pass
npm run check    # render check on each style in styles/index.json, has to end with "Render check passed."
npm start        # builder page at http://127.0.0.1:4173/web/, open it when you change web/
```

`npm start -- --styles <folder>` also lists the style folders inside `<folder>` in the builder. Use it to look at a style that is not in this repository.

To check one style, pass its manifest: `node bin/render-check.js path/to/manifest.json`. Exit code 0 means it passed, 1 means it found issues and 2 means it could not run.

## How to work here

- One branch and one pull request per change. Nobody pushes to `main`.
- Qodo reviews each pull request. Answer each finding on the pull request with the commit that fixes it or with what you did about it.
- I merge. An agent never merges its own pull request.
- A ticket with the `ready-for-agent` label is started by the factory runner on my Mac. [docs/factory.md](docs/factory.md) has the labels and the limits. The runner pushes the branch and opens the pull request, so an agent it starts commits and stops there. Leave `factory/` and `.github/` alone in such a run.
- The one dependency is `pngjs`. Ask in the pull request before you add another.
- Add a test in `test/` when you change what the code does.
- Put each decision the builder page makes in `src/` and test it there: which style opens, what a notice says, how the preview is scaled. `web/` reads the page, calls `src/` and writes the result back.

## Rules

### 1. Full canvas

A layer image is the exact size of the canvas in its manifest, and code draws it at 0,0 at full size. Don't add an x or y offset, a scale or a crop for a layer, in the manifest format or in code.

- **Where:** layer images in a style folder, `src/composite.js`, `src/render-check.js`, `web/builder.js` and `docs/manifest.md`.
- **Why:** I cut the layers of a character from one drawing, and each one lines up with the others when it keeps its place on the full canvas. When a hat sits 2 px off, the art is wrong and I fix the art.

### 2. Keep the check strict

When the render check fails a style, change the layer. Don't raise `overlapTolerance` or `alphaThreshold`, and don't add a `bleed` edge, a wider `zone` or an `over` entry to get a style through. Those manifest fields say how the art is meant to layer, for example a hat that may cover the eyes. A pull request that changes one names the layers it is for.

- **Where:** the defaults in `src/render-check.js`, `bin/render-check.js`, each `manifest.json` and `.github/workflows/ci.yml`.
- **Why:** A user can pick any combination. Two traits that share pixels end up in a picture somebody downloads.

### 3. One compositor

The builder page and the render check draw with `compositeLayers` from `src/composite.js`, and they read manifests through `validateManifest` and `resolveSelection` from `src/manifest.js`. Don't write a second way to stack layers or to turn a layer path into a file.

- **Where:** `src/`, `web/` and `bin/`.
- **Why:** The check has to look at the same picture the user gets. Qodo's review of [pull request #1](https://github.com/CamDuncalfe/agent-pfp/pull/1) found a layer path that the browser and the check read as two different files. The fix was one path rule that both of them use.

### 4. No generated images

The app draws the layer files a manifest names and nothing else. No image-generation API, no model call, and no network request other than loading a style index (`styles/index.json`, and `/local-styles/index.json` on the local server), the manifests it lists and their layers from the same origin.

- **Where:** `web/`, `src/`, `bin/`, `styles/` and the dependencies in `package.json`.
- **Why:** I pick and cut each option before it goes in the builder. A user only gets art I've looked at.

### 5. Art needs a sign-off

Tests and fixtures use the plain shapes drawn by `fixtures/make-fixtures.js`. Add artwork only in a pull request where I've said that art is approved. Don't copy art in from anywhere else, and don't use real art in a test or a screenshot before then.

- **Where:** `fixtures/`, `test/`, `docs/img/` and each style folder.
- **Why:** This repository is public, and I release each character when it's ready.

### 6. Keep the docs true

A pull request corrects each sentence in AGENTS.md, README.md, `docs/` or a code comment that its change makes untrue. The numbered rules are the exception, because they are mine to change. A pull request that runs into one leaves the rule's text alone and says in its description which rule and why, so I can decide.

- **Where:** `AGENTS.md`, `README.md`, `docs/`, the comments in code and the pull request description.
- **Why:** A sentence that is no longer true sends the next agent or reviewer the wrong way. Qodo's review of [pull request #5](https://github.com/CamDuncalfe/agent-pfp/pull/5#issuecomment-6804310388) found that the page had started to load `styles/index.json` while rule 4 still said the manifest and its layers were the only requests allowed. Its review of [pull request #1](https://github.com/CamDuncalfe/agent-pfp/pull/1#issuecomment-6799376654) found a comment in `src/composite.js` that said the page and the check use identical pixels.

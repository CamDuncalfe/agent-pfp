# Style index

[`styles/index.json`](../styles/index.json) lists the styles the builder offers. The builder page reads it and shows one entry per style in the Style picker, in the order of the file. The first style opens by default.

```json
{
  "version": 1,
  "styles": [
    {
      "id": "fixture-shapes",
      "name": "Fixture shapes (test data, not artwork)",
      "manifest": "fixtures/shapes/manifest.json"
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Format version. It is `1`. |
| `styles` | array | The styles, at least one. |
| `styles[].id` | string | The style's id. It is the `style` value of the style's manifest, and each id appears once. |
| `styles[].name` | string | Name shown in the Style picker. |
| `styles[].manifest` | string | Path of the style's `manifest.json`, with forward slashes. It is relative to the folder that holds the `styles/` folder, which is the root of this repository. It follows the same character rules as a layer `src` in [manifest.md](manifest.md), so it cannot use `..` or point at another site. |

`validateStyleIndex(index)` in [`src/styles.js`](../src/styles.js) checks a parsed index and lists what is wrong with it. `resolveManifestUrl(entry, indexUrl)` turns an entry into the URL of its manifest.

## In the builder

- `?style=<id>` in the address opens that style. The address follows the Style picker, so a link opens the style that was on screen.
- An id the index does not list opens the first style, and the page says which id it did not know.
- When a style's manifest cannot be loaded, is not valid or belongs to another style id, the page says which style failed and why. The Style picker keeps working.

## Checking the styles

`npm run check` runs the [render check](render-check.md) on each style in the index:

```sh
node bin/check-styles.js styles/index.json
```

It exits with 0 when each style passes, 1 when a check found issues and 2 when it could not run (an index or manifest that cannot be read or is not valid).

## Styles kept outside the repository

Artwork goes into this repository only after it is approved ([AGENTS.md](../AGENTS.md) rule 5). To look at a style in the builder before that, keep its folder somewhere else and start the local server with the folder that holds it:

```sh
npm start -- --styles ../my-styles      # or: STYLES_DIR=../my-styles npm start
```

```
my-styles/
  marker/
    manifest.json
    layers/...
```

- Each folder directly inside the styles folder that has a `manifest.json` is one style.
- The server sends the folder's `.json` and `.png` files under `/local-styles/`, for GET and HEAD requests only. It answers 404 for dotfiles, for other file types and for a path or a symlink that leaves the folder. It copies nothing into the repository.
- `/local-styles/index.json` lists the styles in the format above, sorted by id, with manifest paths like `local-styles/marker/manifest.json`. The server builds the list on each request, so a style added while it runs shows up when the page is reloaded.
- The Style picker shows the repository's styles first and the local ones after them, with "(local)" after the name.
- A folder is left out of the list, and the server prints one line that says why, when its `manifest.json` is not valid JSON, fails `validateManifest`, uses a style id that another style already has, or when the folder's name uses characters other than letters, digits, hyphens, underscores and dots.
- When the styles folder does not exist or is not a folder, the server prints a message and exits with code 2.

The page asks for `/local-styles/index.json` only when it runs on `127.0.0.1` or `localhost`. Without a styles folder the server answers 404 and the page shows the repository's styles.

`buildLocalIndex` and `mergeStyleLists` in [`src/local-styles.js`](../src/local-styles.js) build the list and merge it into the picker. The render check takes a manifest path, so it runs on a local style the same way: `node bin/render-check.js ../my-styles/marker/manifest.json`.

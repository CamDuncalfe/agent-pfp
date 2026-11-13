# Style index

[`styles/index.json`](../styles/index.json) lists the styles the builder offers, and the characters it shows as coming soon. The builder page reads it and shows one tile per style in the Character tab, the first tab of the trait panel, in the order of the file. A tile shows the picture the style opens with and the style's name under it, and the panel names the picked style. The first style opens by default. After the styles the tab shows one tile per coming-soon character. The index lists the alien as its one style, and eleven coming-soon characters, of which this shows the first:

```json
{
  "version": 1,
  "styles": [
    {
      "id": "alien",
      "name": "Alien",
      "manifest": "styles/alien/manifest.json"
    }
  ],
  "comingSoon": [
    {
      "id": "bear",
      "name": "Bear",
      "picture": "styles/coming-soon/bear.png"
    }
  ]
}
```

The fixture styles are test data, so the builder doesn't offer them. [`fixtures/index.json`](../fixtures/index.json) lists them in the same format, for the render check.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Format version. It is `1`. |
| `styles` | array | The styles, at least one. |
| `styles[].id` | string | The style's id. It is the `style` value of the style's manifest, and each id appears once. |
| `styles[].name` | string | Name of the style's tile in the Character tab: the panel shows it for the picked style, and a screen reader reads it. |
| `styles[].manifest` | string | Path of the style's `manifest.json`, with forward slashes. It is relative to the folder that holds the index's folder. For `styles/index.json` and `fixtures/index.json` that is the root of this repository. It follows the same character rules as a layer `src` in [manifest.md](manifest.md), so it cannot use `..` or point at another site. |
| `comingSoon` | array | Optional. The characters the Character tab shows with a "Coming soon" tag, in order. |
| `comingSoon[].id` | string | The character's id, in the form of a style id. No style and no other coming-soon character has it. |
| `comingSoon[].name` | string | The name under the tile's picture. |
| `comingSoon[].picture` | string | Path of the tile's picture, a `.png` file, relative to the same folder as a manifest path and under the same character rules. |

`validateStyleIndex(index)` in [`src/styles.js`](../src/styles.js) checks a parsed index and lists what is wrong with it. `resolveManifestUrl(entry, indexUrl)` turns an entry into the URL of its manifest, and `resolvePictureUrl(entry, indexUrl)` turns a coming-soon entry into the URL of its picture.

## Coming-soon characters

A coming-soon character is a name and one flat picture. It is not a style: it has no manifest and no layers, and an entry that has a `manifest` field is not valid. The render check, `chooseStyle` and the thumbnail worker read `styles` only, so none of them opens one.

- The pictures are in [`styles/coming-soon/`](../styles/coming-soon/), with a notice about the artwork. Each is the character cut out on a transparent ground, 352 px square, twice the widest picture a tile shows. The page puts it on the yellow of the alien's first background.
- A tile shows the picture, the name and a small "Coming soon" tag. It can't be picked. It holds no radio button, a screen reader reads it as a disabled radio button whose name ends with the tag, and the arrow keys move the focus onto it and leave the pick where it was. `characterTiles` and `characterKeyMove` in [`src/builder-layout.js`](../src/builder-layout.js) decide both.
- Randomize, Reset and Download work from the manifest of the style on screen, which names no coming-soon character.
- To open a character as a style, add its style folder, move its entry from `comingSoon` to `styles` with the path of its manifest in place of `picture`, and delete its picture.

## In the builder

- `?style=<id>` in the address opens that style. The address follows the Character tab, so a link opens the style that was on screen.
- An id the index does not list opens the first style, and the page says which id it did not know.
- The id of a coming-soon character opens the first style too, and the page says the character is coming soon.
- When a style's manifest cannot be loaded, is not valid or belongs to another style id, the page says which style failed and why, and the style's tile stays blank. The Character tab keeps working. It opens with no tile checked, so picking the failed style's tile tries that style again, and the page shows no Size picker until a style is on screen.

## Checking the styles

`npm run check` runs the [render check](render-check.md) on each style in `styles/index.json` and in `fixtures/index.json`:

```sh
node bin/check-styles.js styles/index.json fixtures/index.json
```

`bin/check-styles.js` takes one or more index paths, and `styles/index.json` when it gets none. It reads each index first and then checks each style, so a style that fails in one index doesn't stop the check of the others. It exits with 0 when each style passes, 1 when a check found issues and 2 when it could not run (an index or manifest that cannot be read or is not valid).

## The static site

`npm run build:site` runs `bin/build-site.js`, which writes the builder to `_site/` for GitHub Pages. It copies `web/`, `src/`, the index, each manifest the index lists, each layer those manifests name and the picture of each coming-soon character, and nothing else. It finds them with `resolveManifestUrl`, `resolveLayerUrl` and `resolvePictureUrl`, the rules the builder page uses. When the index or a manifest isn't valid, or a file it names is missing, it says what is wrong and exits with 1. It also exits with 1 when one of these files is a symlink that leads outside the repository, when `web/` or `src/` holds a symlink, or when a layer is at `index.html`, the page the build writes itself. A failed build leaves `_site/` empty.

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
- The Character tab shows the repository's styles first and the local ones after them, with "(local)" after the name. The coming-soon characters come last. A local style with the id of a coming-soon character takes the place of that character's tile, so a character can be looked at as a style before its entry moves to `styles`.
- A folder is left out of the list, and the server prints one line that says why, when its `manifest.json` is not valid JSON, fails `validateManifest`, uses a style id that another style already has, or when the folder's name uses characters other than letters, digits, hyphens, underscores and dots.
- When the styles folder does not exist or is not a folder, the server prints a message and exits with code 2.

The page asks for `/local-styles/index.json` only when it runs on `127.0.0.1` or `localhost`. Without a styles folder the server answers 404 and the page shows the repository's styles.

`buildLocalIndex` and `mergeStyleLists` in [`src/local-styles.js`](../src/local-styles.js) build the list and merge it into the picker. The render check takes a manifest path, so it runs on a local style the same way: `node bin/render-check.js ../my-styles/marker/manifest.json`.

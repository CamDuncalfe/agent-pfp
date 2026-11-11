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

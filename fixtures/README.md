# Fixtures

Test data only. The layers here are plain rectangles and circles drawn by [`make-fixtures.js`](make-fixtures.js). None of it is artwork, and none of it ships in a style.

- `shapes/` is a small style that passes the render check.
- `blocks/` is a second passing style, with a 96x64 canvas and other groups. The tests switch between the two.
- `index.json` lists `shapes/` and `blocks/` in the format of [`styles/index.json`](../docs/styles.md), with manifest paths from the root of the repository. `npm run check` runs the render check on them. The builder doesn't offer them.
- `broken/` has one bad layer for each failure the render check reports: wrong size, blank, cut off by an edge, outside its zone, overlapping another group, and a hole in the finished picture.

Change a shape in `make-fixtures.js`, then run `npm run fixtures` to write the PNG files again.

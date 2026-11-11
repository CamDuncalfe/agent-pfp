# Fixtures

Test data only. The layers here are plain rectangles and circles drawn by [`make-fixtures.js`](make-fixtures.js). None of it is artwork, and none of it ships in a style.

- `shapes/` is a small style that passes the render check. The builder page opens it by default.
- `blocks/` is a second passing style, with a 96x64 canvas and other groups. The builder's Style picker switches between the two.
- `broken/` has one bad layer for each failure the render check reports: wrong size, blank, cut off by an edge, outside its zone, overlapping another group, and a hole in the finished picture.

Change a shape in `make-fixtures.js`, then run `npm run fixtures` to write the PNG files again.

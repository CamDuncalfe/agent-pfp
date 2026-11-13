/**
 * The thumbnails the builder page shows for each trait group. A thumbnail
 * is the current picture with that one option swapped in, cut to a square
 * around the part of the canvas the option's layer draws in. The layers of
 * each group whose `over` list names the tile's group are left out, so a
 * hat or glasses never hide the eyes on an Eyes tile. A layer that
 * covers the whole canvas, like a flat background colour, would be hidden
 * by everything on top of it, so its thumbnail is the layer on its own.
 *
 * The picture is drawn at canvas size by compositeLayers and the square is
 * cut out of the finished picture. No layer is moved, cropped or scaled
 * (AGENTS.md rules 1 and 3).
 *
 * This module has no Node or browser dependencies. The page loads the layer
 * pixels, calls these functions and puts the result on a canvas per tile.
 */
import { compositeLayers, createRaster, isRaster } from './composite.js';
import { groupChoices, hasOneChoice, resolveSelection } from './manifest.js';
import { middleSquare } from './round-preview.js';
import { scaleDown } from './scale.js';

/**
 * How wide a thumbnail is on screen, in CSS pixels. web/builder.css sets
 * the size, and a test keeps the two the same.
 */
export const THUMBNAIL_WIDTH = 56;

/** The most pixels a thumbnail holds along a side: two per CSS pixel. */
export const THUMBNAIL_MAX_SIDE = THUMBNAIL_WIDTH * 2;

/** A pixel counts as drawn when its alpha is at least this, the render check's default. */
export const DRAWN_ALPHA = 16;

/** The room left around a layer's drawn pixels, as a share of the square's side. */
const PADDING = 0.1;

/** The value of the None tile's radio button. An option id is never empty. */
export const NONE_VALUE = '';

/** The text and accessible name of the None tile. */
export const NONE_LABEL = 'None';

/**
 * @typedef {import('./composite.js').Raster} Raster
 * @typedef {import('./manifest.js').Manifest} Manifest
 * @typedef {import('./manifest.js').Group} Group
 * @typedef {import('./manifest.js').Selection} Selection
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ x: number, y: number, side: number }} Square
 */

/**
 * The radio value of a choice: the option id, or NONE_VALUE for `null`.
 * @param {string | null} choice
 */
export function choiceValue(choice) {
  return choice ?? NONE_VALUE;
}

/**
 * The choice a radio value stands for.
 * @param {string} value
 * @returns {string | null}
 */
export function choiceFromValue(value) {
  return value === NONE_VALUE ? null : value;
}

/**
 * The choice a group has on the page: its one option when it has one
 * choice and so no tiles, else the choice of its picked tile, or null
 * when no tile is picked.
 * @param {Group} group
 * @param {string | undefined} pickedValue the radio value of the picked tile
 * @returns {string | null}
 */
export function pageChoice(group, pickedValue) {
  if (hasOneChoice(group)) return groupChoices(group)[0];
  return pickedValue === undefined ? null : choiceFromValue(pickedValue);
}

/**
 * The tiles of a group's grid, in order: a None tile first when the group
 * is optional, then one per option in the manifest's order. The label is
 * the tile's accessible name. A group with one choice gets no tiles,
 * because there is nothing to pick.
 * @param {Group} group
 * @returns {{ choice: string | null, value: string, label: string }[]}
 */
export function traitTiles(group) {
  if (hasOneChoice(group)) return [];
  return groupChoices(group).map((choice) => ({
    choice,
    value: choiceValue(choice),
    label: choice === null ? NONE_LABEL : group.options.find((option) => option.id === choice).label,
  }));
}

/**
 * The smallest rectangle around a layer's drawn pixels, or null when the
 * layer draws nothing.
 * @param {Raster} raster
 * @returns {Rect | null}
 */
export function layerBounds(raster) {
  if (!isRaster(raster)) throw new TypeError('the layer is not an RGBA raster');
  const { width, height, data } = raster;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < DRAWN_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX === -1) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * The smallest rectangle around each of the rectangles. Nulls are skipped.
 * @param {(Rect | null)[]} rects
 * @returns {Rect | null}
 */
export function unionBounds(rects) {
  const list = rects.filter(Boolean);
  if (list.length === 0) return null;
  const left = Math.min(...list.map((rect) => rect.x));
  const top = Math.min(...list.map((rect) => rect.y));
  const right = Math.max(...list.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...list.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Whether a rectangle covers the whole canvas.
 * @param {Rect | null} bounds
 * @param {{ width: number, height: number }} canvas
 */
export function coversCanvas(bounds, canvas) {
  return bounds !== null && bounds.x === 0 && bounds.y === 0 && bounds.width === canvas.width && bounds.height === canvas.height;
}

/**
 * The square a thumbnail shows: centred on the rectangle, as wide as its
 * longer side plus some room around it, and moved inside the canvas when it
 * reaches past an edge. It is never bigger than the canvas's shorter side.
 * Without a rectangle it is the middle square of the canvas.
 * @param {Rect | null} bounds
 * @param {{ width: number, height: number }} canvas
 * @returns {Square}
 */
export function thumbnailSquare(bounds, canvas) {
  const limit = Math.min(canvas.width, canvas.height);
  if (bounds === null) return middleSquare(canvas);
  const longer = Math.max(bounds.width, bounds.height);
  const side = Math.min(limit, longer + 2 * Math.round(longer * PADDING));
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  const clamp = (start, size) => Math.max(0, Math.min(size - side, Math.round(start)));
  return { x: clamp(centreX - side / 2, canvas.width), y: clamp(centreY - side / 2, canvas.height), side };
}

/**
 * The square cut out of a picture, at THUMBNAIL_MAX_SIDE pixels a side at
 * most. A smaller square is copied pixel for pixel, a bigger one is scaled
 * down with scaleDown.
 * @param {Raster} picture
 * @param {Square} square
 * @returns {Raster}
 */
export function thumbnailPicture(picture, square) {
  const { x, y, side } = square;
  if (side > THUMBNAIL_MAX_SIDE) {
    return scaleDown(picture, THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, { x, y, width: side, height: side });
  }
  const out = createRaster(side, side);
  for (let row = 0; row < side; row += 1) {
    const start = ((y + row) * picture.width + x) * 4;
    out.data.set(picture.data.subarray(start, start + side * 4), row * side * 4);
  }
  return out;
}

/**
 * The selection a tile shows: `selection` with `choice` in the tile's group.
 * @param {Selection} selection
 * @param {string} groupId
 * @param {string | null} choice
 * @returns {Selection}
 */
export function thumbnailSelection(selection, groupId, choice) {
  return { ...selection, [groupId]: choice };
}

/**
 * Whether a group's layers are left out of the thumbnails of another
 * group: they are when the group's `over` list names it.
 * @param {Group} group
 * @param {string} tileGroupId
 */
export function coversInThumbnails(group, tileGroupId) {
  return Array.isArray(group.over) && group.over.includes(tileGroupId);
}

/**
 * The layers a tile's thumbnail draws, bottom first: the layers of
 * `selection` with `choice` in the tile's group, less the layers of each
 * group whose `over` list names the tile's group. The main preview and the
 * download draw each layer of the selection and don't use this.
 * @param {Manifest} manifest
 * @param {Selection} selection
 * @param {string} groupId the tile's group
 * @param {string | null} choice the tile's option id, or null for None
 */
export function thumbnailLayers(manifest, selection, groupId, choice) {
  return resolveSelection(manifest, thumbnailSelection(selection, groupId, choice)).filter(
    (layer) => !coversInThumbnails(layer.group, groupId),
  );
}

/**
 * What a group's thumbnails depend on: the choice of each other group that
 * they draw. The page redraws a group's thumbnails only when this changes,
 * so picking a tile redraws the other groups' thumbnails and leaves its own
 * as they are. A change in a group drawn over it leaves them as they are too.
 * @param {Manifest} manifest
 * @param {Selection} selection
 * @param {string} groupId
 * @returns {string}
 */
export function thumbnailKey(manifest, selection, groupId) {
  return JSON.stringify(
    manifest.groups
      .filter((group) => group.id !== groupId && !coversInThumbnails(group, groupId))
      .map((group) => selection[group.id] ?? null),
  );
}

/**
 * Which thumbnailKey each group's tiles show. The page calls `start` before
 * it paints the first tile of a group and `finish` after the last one. A
 * redraw that stops or fails in between leaves the group with no key, so
 * the next render redraws it, also when it goes back to the key before.
 */
export function createRedrawTracker() {
  /** @type {Map<string, string>} */
  const drawn = new Map();
  return {
    /** Whether the group's tiles show something other than `key`. */
    needsRedraw(groupId, key) {
      return drawn.get(groupId) !== key;
    },
    start(groupId) {
      drawn.delete(groupId);
    },
    finish(groupId, key) {
      drawn.set(groupId, key);
    },
  };
}

/**
 * The layer sources a group's thumbnails need: each layer of `selection`
 * that the thumbnails draw and each option of the group.
 * @param {Manifest} manifest
 * @param {Selection} selection
 * @param {Group} group
 * @returns {string[]}
 */
export function thumbnailSources(manifest, selection, group) {
  const sources = new Set(
    resolveSelection(manifest, selection)
      .filter((layer) => !coversInThumbnails(layer.group, group.id))
      .filter((layer) => layer.group.id !== group.id)
      .map(({ option }) => option.src),
  );
  for (const option of group.options) sources.add(option.src);
  return [...sources];
}

/**
 * Draw one tile's thumbnail.
 *
 * An option whose layer covers the whole canvas shows that layer on its
 * own, cut to the middle square, so a background tile is its colour. Any
 * other option is drawn on the current picture and cut to a square around
 * its layer's drawn pixels. The None tile shows the picture without the
 * group, cut to a square around the drawn pixels of each of its options.
 * Both leave out the groups drawn over the tile's group (thumbnailLayers).
 *
 * @param {object} args
 * @param {Manifest} args.manifest
 * @param {Selection} args.selection what the page shows now
 * @param {Group} args.group the tile's group
 * @param {string | null} args.choice the tile's option id, or null for None
 * @param {(src: string) => Raster} args.pixelsOf the layer's pixels at canvas size
 * @param {(src: string) => Rect | null} [args.boundsOf] layerBounds of the layer, cached by the caller
 * @returns {Raster}
 */
export function drawThumbnail({ manifest, selection, group, choice, pixelsOf, boundsOf }) {
  const bounds = boundsOf ?? ((src) => layerBounds(pixelsOf(src)));
  const { canvas } = manifest;
  if (choice !== null) {
    const option = group.options.find((candidate) => candidate.id === choice);
    if (!option) throw new Error(`group "${group.id}" has no option "${choice}"`);
    const own = bounds(option.src);
    if (coversCanvas(own, canvas)) return thumbnailPicture(pixelsOf(option.src), middleSquare(canvas));
  }
  const layers = thumbnailLayers(manifest, selection, group.id, choice);
  const picture = compositeLayers(
    canvas.width,
    canvas.height,
    layers.map(({ option }) => pixelsOf(option.src)),
  );
  const area =
    choice === null
      ? unionBounds(group.options.map((option) => bounds(option.src)))
      : bounds(group.options.find((option) => option.id === choice).src);
  return thumbnailPicture(picture, thumbnailSquare(area, canvas));
}

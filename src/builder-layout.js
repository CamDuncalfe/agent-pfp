/**
 * Where each trait group goes on the builder page, and what Reset and the
 * tabs do. web/builder.js reads the page, calls these functions and writes
 * the result back.
 *
 * - The background group's options are swatches in a column on the left of
 *   the preview (swatchGroup).
 * - Each other group with tiles is a tab in one panel (tabGroups).
 * - Reset gives each group the choice the page opens with, its first tile,
 *   and turns each Lock off (resetState).
 * - Each style is a tile in the character row at the top, showing the
 *   picture the style opens with (basePicture).
 *
 * This module has no Node or browser dependencies.
 */
import { compositeLayers } from './composite.js';
import { groupChoices, resolveSelection } from './manifest.js';
import { hasLock, startingLocks } from './locks.js';
import { middleSquare } from './round-preview.js';
import { NONE_LABEL, thumbnailPicture, traitTiles } from './thumbnails.js';

/** The id of the group whose options are swatches next to the preview. */
export const SWATCH_GROUP_ID = 'background';

/**
 * @typedef {import('./manifest.js').Manifest} Manifest
 * @typedef {import('./manifest.js').Group} Group
 * @typedef {import('./manifest.js').Selection} Selection
 */

/**
 * The group shown as swatches in the column next to the preview: the group
 * with the id "background", when it has tiles. Null when the style has no
 * such group, or when it has one choice and so nothing to pick.
 * @param {Manifest} manifest
 * @returns {Group | null}
 */
export function swatchGroup(manifest) {
  const group = manifest.groups.find((item) => item.id === SWATCH_GROUP_ID);
  return group && traitTiles(group).length > 0 ? group : null;
}

/**
 * The groups shown as tabs in the trait panel, in manifest order: each
 * group with tiles, less the swatch group.
 * @param {Manifest} manifest
 * @returns {Group[]}
 */
export function tabGroups(manifest) {
  const swatches = swatchGroup(manifest);
  return manifest.groups.filter((group) => group !== swatches && traitTiles(group).length > 0);
}

/**
 * The choice each group has when the page opens a style: its first tile,
 * which is None for an optional group, or its one option for a group with
 * one choice.
 * @param {Manifest} manifest
 * @returns {Selection}
 */
export function defaultSelection(manifest) {
  return Object.fromEntries(manifest.groups.map((group) => [group.id, groupChoices(group)[0]]));
}

/**
 * What Reset puts on the page: the choices the page opens with, and each
 * Lock off.
 * @param {Manifest} manifest
 * @returns {{ selection: Selection, locks: Record<string, boolean> }}
 */
export function resetState(manifest) {
  return { selection: defaultSelection(manifest), locks: startingLocks(manifest) };
}

/**
 * Whether Reset would change anything: a group has another choice than the
 * one the page opens with, or a Lock is on.
 * @param {Manifest} manifest
 * @param {Selection} selection
 * @param {Record<string, boolean>} locks
 */
export function canReset(manifest, selection, locks) {
  const start = defaultSelection(manifest);
  return manifest.groups.some(
    (group) => (selection[group.id] ?? null) !== start[group.id] || (hasLock(group) && locks[group.id] === true),
  );
}

/**
 * The name of a group's current choice, shown next to the group's name in
 * the panel: the option's label, or None.
 * @param {Group} group
 * @param {string | null} choice
 * @returns {string}
 */
export function choiceLabel(group, choice) {
  if (choice === null) return NONE_LABEL;
  const option = group.options.find((item) => item.id === choice);
  if (!option) throw new Error(`group "${group.id}" has no option "${choice}"`);
  return option.label;
}

/**
 * The tab a key moves to in a tablist of `count` tabs, or null for a key
 * the tablist doesn't use. The arrow keys wrap around the ends, and Home
 * and End go to the first and the last tab.
 * @param {number} index the tab with focus
 * @param {string} key KeyboardEvent.key
 * @param {number} count
 * @returns {number | null}
 */
export function tabAfterKey(index, key, count) {
  if (count < 1) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The layers of the picture a style opens with, bottom first: its default
 * selection (defaultSelection).
 * @param {Manifest} manifest
 */
export function baseLayers(manifest) {
  return resolveSelection(manifest, defaultSelection(manifest));
}

/**
 * The picture on a style's tile in the character row: the picture the
 * style opens with, drawn by compositeLayers at canvas size, then its middle
 * square at THUMBNAIL_MAX_SIDE pixels a side at most (thumbnailPicture).
 * No layer is moved, cropped or scaled (AGENTS.md rules 1 and 3).
 * @param {Manifest} manifest
 * @param {(src: string) => import('./composite.js').Raster} pixelsOf the layer's pixels at canvas size
 */
export function basePicture(manifest, pixelsOf) {
  const { width, height } = manifest.canvas;
  const picture = compositeLayers(
    width,
    height,
    baseLayers(manifest).map(({ option }) => pixelsOf(option.src)),
  );
  return thumbnailPicture(picture, middleSquare(manifest.canvas));
}

/**
 * Whether the thumbnail worker may composite a character picture now: only
 * while no trait thumbnail request is running or waiting, so a trait change
 * never waits behind the character row.
 * @param {{ running: boolean, waiting: number }} thumbnails the worker's trait thumbnail loop
 */
export function mayDrawBase({ running, waiting }) {
  return !running && waiting === 0;
}

/**
 * Whether a character picture reuses the layers the trait thumbnails
 * loaded: only when it is for the style those thumbnails show. Another
 * style gets a loader of its own.
 * @param {string | null} thumbnailStyleUrl the manifest URL of the style the thumbnails show, or null before the first
 * @param {string} manifestUrl the manifest URL of the character picture's style
 */
export function reusesThumbnailLayers(thumbnailStyleUrl, manifestUrl) {
  return thumbnailStyleUrl !== null && thumbnailStyleUrl === manifestUrl;
}

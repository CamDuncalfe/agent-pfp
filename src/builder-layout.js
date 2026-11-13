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
 * - Each style is a tile in the Character tab, the first tab of the panel,
 *   showing the picture the style opens with (basePicture). Which tab
 *   opens with a style is tabToOpen, and after a style that failed to load
 *   it is tabAfterFailedStyle. Which tile is checked is characterPick: none
 *   after a failed load, so the failed style can be picked again.
 * - Reset turns itself off, and focusAfterReset says where the focus goes.
 * - After the styles, the Character tab shows each coming-soon character
 *   as a tile that can't be picked (characterTiles, characterKeyMove).
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
 * and End go to the first and the last tab. A key pressed with Alt, Control
 * or Meta is the browser's, like Alt and Left for going back a page, so the
 * tablist leaves it alone.
 * @param {number} index the tab with focus
 * @param {string} key KeyboardEvent.key
 * @param {number} count
 * @param {boolean} [modified] whether Alt, Control or Meta is held
 * @returns {number | null}
 */
export function tabAfterKey(index, key, count, modified = false) {
  if (modified || count < 1) return null;
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
 * The picture on a style's tile in the Character tab: the picture the
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
 * How long a character picture waits for the trait thumbnails at most, in
 * milliseconds. The alien's first set of trait thumbnails takes about two
 * seconds on a fast machine, so the limit is well past that: when a style
 * opens, the trait thumbnails still all come first.
 */
export const BASE_WAIT_LIMIT_MS = 8000;

/** How long the thumbnail worker sleeps between two looks at whether a character picture may draw, in milliseconds. */
export const BASE_POLL_MS = 50;

/**
 * Whether the thumbnail worker may composite a character picture now: while
 * no trait thumbnail request is running or waiting, so a trait change
 * doesn't wait behind the character pictures. A picture that has waited
 * BASE_WAIT_LIMIT_MS draws anyway, between two trait thumbnails, so a tile
 * never stays blank while trait changes keep coming.
 * @param {{ running: boolean, waiting: number, waitedMs?: number }} thumbnails the worker's trait thumbnail
 *   loop, and how long this picture has waited for it
 */
export function mayDrawBase({ running, waiting, waitedMs = 0 }) {
  return (!running && waiting === 0) || waitedMs >= BASE_WAIT_LIMIT_MS;
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

/**
 * Whether the Character tab is the open tab when a style goes on screen.
 * When the page opens, it is open only if there is more than one style to
 * pick from; with one, the first trait tab opens instead. After a switch
 * from the Character tab, it stays open, so the next pick is one click away.
 * A coming-soon character is no style to pick from, so it doesn't count.
 * @param {{ styleCount: number, firstStyle: boolean }} state styleCount is the number of styles that can be
 *   picked, and firstStyle is true for the style the page opens with
 */
export function characterTabOpens({ styleCount, firstStyle }) {
  return !firstStyle || styleCount > 1;
}

/** The tag on the tile of a character that can't be picked yet. It is the reason the tile gives. */
export const COMING_SOON_TAG = 'Coming soon';

/**
 * @typedef {{ id: string, name: string, comingSoon: false, style: object }} StyleTile
 * @typedef {{ id: string, name: string, comingSoon: true, picture: string }} ComingSoonTile
 */

/**
 * The tiles of the Character tab, in order: one per style, then one per
 * coming-soon character. A style can be picked. A coming-soon character
 * can't: its tile has a picture, a name and the tag, and no manifest.
 *
 * A coming-soon character whose id a style already uses is left out, so a
 * style looked at from a local folder takes the place of its coming-soon
 * tile.
 *
 * @param {{ id: string, name: string }[]} styles the styles the tab offers (mergeStyleLists)
 * @param {{ id: string, name: string, picture: string }[]} comingSoon the index's coming-soon characters
 * @returns {(StyleTile | ComingSoonTile)[]}
 */
export function characterTiles(styles, comingSoon) {
  const taken = new Set(styles.map((style) => style.id));
  return [
    ...styles.map((style) => ({ id: style.id, name: style.name, comingSoon: false, style })),
    ...comingSoon
      .filter((entry) => !taken.has(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.name, comingSoon: true, picture: entry.picture })),
  ];
}

/**
 * Where an arrow key takes the focus in the Character tab, and whether the
 * tile it lands on becomes the pick. The keys are a radio group's: Right and
 * Down go to the next tile, Left and Up to the one before, and both wrap
 * around the ends. Focus reaches a coming-soon tile, so a keyboard user gets
 * to its tag, and that tile is never picked: the pick stays where it was.
 *
 * An arrow key pressed with Alt, Control or Meta is the browser's, for
 * going back a page for one, so the tab leaves it alone.
 *
 * @param {{ comingSoon: boolean }[]} tiles the tab's tiles (characterTiles)
 * @param {number} index the tile with focus
 * @param {string} key KeyboardEvent.key
 * @param {boolean} [modified] whether Alt, Control or Meta is held
 * @returns {{ index: number, pick: boolean } | null} null for a key the tab doesn't use, or when no tile has focus
 */
export function characterKeyMove(tiles, index, key, modified = false) {
  const count = tiles.length;
  if (modified || count < 1 || index < 0 || index >= count) return null;
  let next;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % count;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + count) % count;
      break;
    default:
      return null;
  }
  return { index: next, pick: !tiles[next].comingSoon };
}

/** The position of the Character tab in the panel's tablist: it is the first tab. */
export const CHARACTER_TAB = 0;

/**
 * The tab that is open when a style goes on screen, as its position in the
 * tablist. It is the Character tab when characterTabOpens says so, and also
 * when the style has no trait tab, because then it is the only tab.
 * Otherwise it is the first trait tab, the one after Character.
 * @param {{ styleCount: number, firstStyle: boolean, tabCount: number }} state styleCount and firstStyle as in
 *   characterTabOpens, and tabCount is the number of tabs in the tablist, the Character tab included
 * @returns {number}
 */
export function tabToOpen({ styleCount, firstStyle, tabCount }) {
  if (tabCount <= 1) return CHARACTER_TAB;
  return characterTabOpens({ styleCount, firstStyle }) ? CHARACTER_TAB : CHARACTER_TAB + 1;
}

/**
 * The tab that is open after a style failed to load: the Character tab, so
 * another style can be picked. An open tab is the tablist's Tab stop and its
 * panel is on screen, so a keyboard user reaches the tiles too.
 * @returns {number}
 */
export function tabAfterFailedStyle() {
  return CHARACTER_TAB;
}

/**
 * What the Character tab shows as its pick for the style last asked for:
 * the tile that is checked and the name beside the heading. While the style
 * loads and while it is on screen, that is the style. After it failed to
 * load there is no pick, because nothing of the style is on screen. Its tile
 * is then a tile like the others, so a click or Space on it picks it and
 * opens the style once more.
 * @param {{ id: string, name: string }} entry the style last asked for
 * @param {boolean} failed whether it failed to load
 * @returns {{ id: string | null, name: string }} `id` is null when no tile is checked
 */
export function characterPick(entry, failed) {
  return failed ? { id: null, name: '' } : { id: entry.id, name: entry.name };
}

/**
 * Where the focus goes after Reset. Reset is off while the picks and the
 * Locks are the ones the style opens with, so a press turns it off. A button
 * that is off can't hold the focus, and a keyboard user would lose their
 * place on the page. The focus goes to Randomize, the button beside it.
 * @param {{ resetHadFocus: boolean, resetDisabled: boolean, randomizeDisabled: boolean }} state
 *   resetHadFocus is read before the reset, and the other two after it
 * @returns {'randomize' | null} null when the focus stays where it is
 */
export function focusAfterReset({ resetHadFocus, resetDisabled, randomizeDisabled }) {
  return resetHadFocus && resetDisabled && !randomizeDisabled ? 'randomize' : null;
}

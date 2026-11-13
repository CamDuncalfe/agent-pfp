/**
 * Style index: one JSON file that lists the styles the builder offers, and
 * the characters it shows as coming soon. The format is documented in
 * docs/styles.md.
 *
 * This module has no Node or browser dependencies, so the builder page, the
 * command line tools and the tests share it.
 */
import { isSafeRelativePath } from './manifest.js';

export const STYLE_INDEX_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * A character the index names before it is a style: a name and one flat
 * picture for its tile. It has no manifest and no layers, so nothing opens
 * it, checks it or draws it as a style.
 *
 * @typedef {{ id: string, name: string, manifest: string }} StyleEntry
 * @typedef {{ id: string, name: string, picture: string }} ComingSoonEntry
 * @typedef {{ version: number, styles: StyleEntry[], comingSoon?: ComingSoonEntry[] }} StyleIndex
 */

/** The file type of a coming-soon character's picture. */
const PICTURE_TYPE = '.png';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a parsed style index against the format.
 * @param {unknown} index
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStyleIndex(index) {
  if (!isPlainObject(index)) {
    return { ok: false, errors: ['style index must be a JSON object'] };
  }
  const errors = [];
  if (index.version !== STYLE_INDEX_VERSION) {
    errors.push(`version must be ${STYLE_INDEX_VERSION}`);
  }
  if (!Array.isArray(index.styles) || index.styles.length === 0) {
    errors.push('styles must list at least one style');
    return { ok: false, errors };
  }
  const seen = new Set();
  index.styles.forEach((entry, position) => {
    const at = `styles[${position}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      errors.push(`${at}.id must be lowercase letters, digits and hyphens, starting with a letter`);
    } else if (seen.has(entry.id)) {
      errors.push(`${at}.id "${entry.id}" is used twice`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      errors.push(`${at}.name must be a non-empty string`);
    }
    if (!isSafeRelativePath(entry.manifest) || !entry.manifest.endsWith('.json')) {
      errors.push(`${at}.manifest must be a relative path to a .json file inside the site`);
    }
  });
  if (index.comingSoon !== undefined) {
    if (!Array.isArray(index.comingSoon)) {
      errors.push('comingSoon must be a list when it is there');
    } else {
      index.comingSoon.forEach((entry, position) => {
        const at = `comingSoon[${position}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${at} must be an object`);
          return;
        }
        if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
          errors.push(`${at}.id must be lowercase letters, digits and hyphens, starting with a letter`);
        } else if (seen.has(entry.id)) {
          errors.push(`${at}.id "${entry.id}" is used twice`);
        } else {
          seen.add(entry.id);
        }
        if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
          errors.push(`${at}.name must be a non-empty string`);
        }
        if (!isSafeRelativePath(entry.picture) || !entry.picture.endsWith(PICTURE_TYPE)) {
          errors.push(`${at}.picture must be a relative path to a ${PICTURE_TYPE} file inside the site`);
        }
        // A character with a manifest is a style. It goes in styles, where it is checked and opened.
        if ('manifest' in entry) {
          errors.push(`${at} has a manifest, so it belongs in styles`);
        }
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The characters an index names as coming soon, in its order. An index
 * without the list has none.
 * @param {{ comingSoon?: ComingSoonEntry[] }} index a valid style index
 * @returns {ComingSoonEntry[]}
 */
export function comingSoonEntries(index) {
  return index.comingSoon ?? [];
}

/**
 * The folder that manifest paths in an index are relative to: the folder
 * that holds the index's own folder. For `/styles/index.json` that is `/`.
 * @param {string | URL} indexUrl
 * @returns {URL}
 */
export function styleRootUrl(indexUrl) {
  return new URL('..', indexUrl);
}

/**
 * The URL of a style's manifest, given the URL of the index that lists it.
 * Throws when the path is not a safe relative path or the result is outside
 * the index's root folder.
 * @param {StyleEntry} entry
 * @param {string | URL} indexUrl
 * @returns {URL}
 */
export function resolveManifestUrl(entry, indexUrl) {
  if (!isSafeRelativePath(entry.manifest)) {
    throw new Error(`manifest path "${entry.manifest}" is not a relative path inside the site`);
  }
  const root = styleRootUrl(indexUrl);
  const url = new URL(entry.manifest, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error(`manifest path "${entry.manifest}" is outside the site`);
  }
  return url;
}

/**
 * The URL of a coming-soon character's picture, given the URL of the index
 * that names it. The path follows the rule of a manifest path: relative to
 * the folder that holds the index's folder, and inside it.
 * @param {ComingSoonEntry} entry
 * @param {string | URL} indexUrl
 * @returns {URL}
 */
export function resolvePictureUrl(entry, indexUrl) {
  if (!isSafeRelativePath(entry.picture)) {
    throw new Error(`picture path "${entry.picture}" is not a relative path inside the site`);
  }
  const root = styleRootUrl(indexUrl);
  const url = new URL(entry.picture, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error(`picture path "${entry.picture}" is outside the site`);
  }
  return url;
}

/**
 * Choose the style to open. An id the index does not list falls back to the
 * first style, and `unknown` carries the id so the page can say so.
 * @param {StyleIndex} index
 * @param {string | null | undefined} requestedId
 * @returns {{ entry: StyleEntry, unknown: string | null }}
 */
export function chooseStyle(index, requestedId) {
  const first = index.styles[0];
  if (requestedId === null || requestedId === undefined || requestedId === '') {
    return { entry: first, unknown: null };
  }
  const entry = index.styles.find((candidate) => candidate.id === requestedId);
  return entry ? { entry, unknown: null } : { entry: first, unknown: requestedId };
}

/**
 * A manifest opened through an index has to be the style the index names.
 * @param {StyleEntry} entry
 * @param {{ style: string }} manifest
 * @returns {string | null} what is wrong, or null
 */
export function styleMismatch(entry, manifest) {
  return manifest.style === entry.id
    ? null
    : `the index lists this style as "${entry.id}" and its manifest says "${manifest.style}"`;
}

/**
 * What the page says when the address names a style the index does not list.
 * @param {string} unknown the id from the address
 * @param {StyleEntry} entry the style that opens instead
 * @returns {string}
 */
export function unknownStyleNotice(unknown, entry) {
  return `This builder doesn't know a style called "${unknown}". Showing ${entry.name}.`;
}

/**
 * What the page says when the address names a character that is coming
 * soon. It can't be opened yet, so the first style opens.
 * @param {ComingSoonEntry} coming the character the address names
 * @param {StyleEntry} entry the style that opens instead
 * @returns {string}
 */
export function comingSoonNotice(coming, entry) {
  return `${coming.name} is coming soon. Showing ${entry.name}.`;
}

/**
 * The style a page address asks for. Only the `style` parameter is read.
 * The id of a coming-soon character opens the first style, like an id the
 * index does not list, and the notice says the character is coming soon.
 * @param {StyleIndex} index
 * @param {string} search the query string of the address, with or without "?"
 * @returns {{ entry: StyleEntry, notice: string }} `notice` is empty unless the id was not a style's
 */
export function styleFromSearch(index, search) {
  const requested = new URLSearchParams(search).get('style');
  const { entry, unknown } = chooseStyle(index, requested);
  if (unknown === null) return { entry, notice: '' };
  const coming = comingSoonEntries(index).find((candidate) => candidate.id === unknown);
  return { entry, notice: coming ? comingSoonNotice(coming, entry) : unknownStyleNotice(unknown, entry) };
}

/**
 * Opens one style at a time. When a second style is opened while the first
 * is still loading, the first one is dropped when it arrives: it is not
 * shown and its failure is not reported.
 *
 * @template Loaded
 * @param {{
 *   clear: (entry: StyleEntry) => void,
 *   load: (entry: StyleEntry) => Promise<Loaded>,
 *   show: (entry: StyleEntry, loaded: Loaded, isOnScreen: () => boolean) => void | Promise<void>,
 *   fail: (entry: StyleEntry, error: unknown) => void,
 * }} steps `clear` runs first on each switch, then `load`, then `show` or `fail`
 * @returns {{ open: (entry: StyleEntry) => Promise<boolean> }} `open` resolves to true when the style ended up on screen
 */
export function createStyleSwitcher({ clear, load, show, fail }) {
  let latest = 0;
  return {
    async open(entry) {
      const ticket = (latest += 1);
      const isOnScreen = () => ticket === latest;
      clear(entry);
      try {
        const loaded = await load(entry);
        if (!isOnScreen()) return false;
        await show(entry, loaded, isOnScreen);
        return isOnScreen();
      } catch (error) {
        if (isOnScreen()) fail(entry, error);
        return false;
      }
    },
  };
}

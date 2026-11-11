/**
 * Style index: one JSON file that lists the styles the builder offers. The
 * format is documented in docs/styles.md.
 *
 * This module has no Node or browser dependencies, so the builder page, the
 * command line tools and the tests share it.
 */
import { isSafeRelativePath } from './manifest.js';

export const STYLE_INDEX_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {{ id: string, name: string, manifest: string }} StyleEntry
 * @typedef {{ version: number, styles: StyleEntry[] }} StyleIndex
 */

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
  return { ok: errors.length === 0, errors };
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

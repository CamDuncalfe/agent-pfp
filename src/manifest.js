/**
 * Layer manifest: one JSON file per art style. It lists the trait groups in
 * draw order (first group is drawn first, so it sits at the bottom) and the
 * options a user can pick in each group. The format is documented in
 * docs/manifest.md.
 *
 * This module has no Node or browser dependencies, so the builder page and
 * the command line tools share it.
 */

export const MANIFEST_VERSION = 1;

export const EDGES = Object.freeze(['top', 'right', 'bottom', 'left']);

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ id: string, label: string, src: string }} Option
 * @typedef {{
 *   id: string,
 *   label: string,
 *   optional?: boolean,
 *   base?: boolean,
 *   bleed?: string[],
 *   zone?: Rect,
 *   over?: string[],
 *   options: Option[],
 * }} Group
 * @typedef {{
 *   version: number,
 *   style: string,
 *   name: string,
 *   canvas: { width: number, height: number, opaque?: boolean },
 *   groups: Group[],
 * }} Manifest
 * @typedef {Record<string, string | null>} Selection
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A layer path must stay inside the style folder: relative, forward slashes,
 * no "." or ".." segments, no scheme, no query or fragment.
 */
export function isSafeRelativePath(src) {
  if (!isNonEmptyString(src)) return false;
  if (src.startsWith('/') || src.includes('\\')) return false;
  if (/[?#:]/.test(src)) return false;
  return src.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validateZone(zone, canvas, where, errors) {
  if (!isPlainObject(zone)) {
    errors.push(`${where}.zone must be an object with x, y, width and height`);
    return;
  }
  const { x, y, width, height } = zone;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    errors.push(`${where}.zone x and y must be integers of 0 or more`);
    return;
  }
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    errors.push(`${where}.zone width and height must be positive integers`);
    return;
  }
  if (canvas && (x + width > canvas.width || y + height > canvas.height)) {
    errors.push(`${where}.zone reaches outside the ${canvas.width}x${canvas.height} canvas`);
  }
}

function validateOptions(group, where, errors) {
  if (!Array.isArray(group.options) || group.options.length === 0) {
    errors.push(`${where}.options must list at least one option`);
    return;
  }
  const seen = new Set();
  group.options.forEach((option, index) => {
    const at = `${where}.options[${index}]`;
    if (!isPlainObject(option)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof option.id !== 'string' || !ID_PATTERN.test(option.id)) {
      errors.push(`${at}.id must be lowercase letters, digits and hyphens, starting with a letter`);
    } else if (seen.has(option.id)) {
      errors.push(`${at}.id "${option.id}" is used twice in this group`);
    } else {
      seen.add(option.id);
    }
    if (!isNonEmptyString(option.label)) errors.push(`${at}.label must be a non-empty string`);
    if (!isSafeRelativePath(option.src)) {
      errors.push(`${at}.src must be a relative path inside the style folder`);
    }
  });
}

/**
 * Check a parsed manifest against the format.
 * @param {unknown} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(`version must be ${MANIFEST_VERSION}`);
  }
  if (typeof manifest.style !== 'string' || !ID_PATTERN.test(manifest.style)) {
    errors.push('style must be lowercase letters, digits and hyphens, starting with a letter');
  }
  if (!isNonEmptyString(manifest.name)) errors.push('name must be a non-empty string');

  let canvas = null;
  if (!isPlainObject(manifest.canvas)) {
    errors.push('canvas must be an object with width and height');
  } else if (!isPositiveInteger(manifest.canvas.width) || !isPositiveInteger(manifest.canvas.height)) {
    errors.push('canvas.width and canvas.height must be positive integers');
  } else {
    canvas = manifest.canvas;
    if (canvas.opaque !== undefined && typeof canvas.opaque !== 'boolean') {
      errors.push('canvas.opaque must be true or false');
    }
  }

  if (!Array.isArray(manifest.groups) || manifest.groups.length === 0) {
    errors.push('groups must list at least one group');
    return { ok: false, errors };
  }

  const earlier = new Set();
  manifest.groups.forEach((group, index) => {
    const where = `groups[${index}]`;
    if (!isPlainObject(group)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const idOk = typeof group.id === 'string' && ID_PATTERN.test(group.id);
    if (!idOk) {
      errors.push(`${where}.id must be lowercase letters, digits and hyphens, starting with a letter`);
    } else if (earlier.has(group.id)) {
      errors.push(`${where}.id "${group.id}" is used twice`);
    }
    if (!isNonEmptyString(group.label)) errors.push(`${where}.label must be a non-empty string`);
    for (const flag of ['optional', 'base']) {
      if (group[flag] !== undefined && typeof group[flag] !== 'boolean') {
        errors.push(`${where}.${flag} must be true or false`);
      }
    }
    if (group.bleed !== undefined) {
      if (!Array.isArray(group.bleed) || group.bleed.some((edge) => !EDGES.includes(edge))) {
        errors.push(`${where}.bleed must be a list drawn from ${EDGES.join(', ')}`);
      }
    }
    if (group.zone !== undefined) validateZone(group.zone, canvas, where, errors);
    if (group.over !== undefined) {
      if (!Array.isArray(group.over)) {
        errors.push(`${where}.over must be a list of group ids`);
      } else {
        for (const target of group.over) {
          if (!earlier.has(target)) {
            errors.push(`${where}.over names "${target}", which is not a group drawn before this one`);
          }
        }
      }
    }
    validateOptions(group, where, errors);
    if (idOk) earlier.add(group.id);
  });

  return { ok: errors.length === 0, errors };
}

/**
 * The choices a user has in a group. An optional group can also be left
 * empty, which is the choice `null`.
 * @param {Group} group
 * @returns {(string | null)[]}
 */
export function groupChoices(group) {
  const ids = group.options.map((option) => option.id);
  return group.optional ? [null, ...ids] : ids;
}

/**
 * Turn a selection into the list of layers to draw, bottom first.
 * Throws when the selection names an unknown group or option, or leaves a
 * required group empty.
 * @param {Manifest} manifest
 * @param {Selection} selection
 * @returns {{ group: Group, option: Option }[]}
 */
export function resolveSelection(manifest, selection) {
  const known = new Set(manifest.groups.map((group) => group.id));
  for (const key of Object.keys(selection)) {
    if (!known.has(key)) throw new Error(`selection names unknown group "${key}"`);
  }
  const layers = [];
  for (const group of manifest.groups) {
    const choice = selection[group.id] ?? null;
    if (choice === null) {
      if (!group.optional) throw new Error(`group "${group.id}" needs an option`);
      continue;
    }
    const option = group.options.find((candidate) => candidate.id === choice);
    if (!option) throw new Error(`group "${group.id}" has no option "${choice}"`);
    layers.push({ group, option });
  }
  return layers;
}

/**
 * Pick one choice per group.
 * @param {Manifest} manifest
 * @param {() => number} [random] returns a number in [0, 1), like Math.random
 * @returns {Selection}
 */
export function randomSelection(manifest, random = Math.random) {
  const selection = {};
  for (const group of manifest.groups) {
    const choices = groupChoices(group);
    const index = Math.min(choices.length - 1, Math.floor(random() * choices.length));
    selection[group.id] = choices[index];
  }
  return selection;
}

/**
 * Trait locks in the builder. A locked group keeps its option when the user
 * hits Randomize. A lock does nothing else: a click on one of the group's
 * thumbnails still changes it.
 *
 * This module has no Node or browser dependencies. The builder page reads
 * the lock checkboxes, calls these functions and writes the result back.
 */

import { groupChoices, hasOneChoice, randomChoice } from './manifest.js';

/**
 * @typedef {import('./manifest.js').Manifest} Manifest
 * @typedef {import('./manifest.js').Group} Group
 * @typedef {import('./manifest.js').Selection} Selection
 * @typedef {Record<string, boolean>} Locks group id to "is locked"
 */

/**
 * The form name of a group's lock checkbox. A group id has no colon, so the
 * name never matches the name of a group's tiles.
 * @param {string} groupId
 */
export function lockControlName(groupId) {
  return `lock:${groupId}`;
}

/** The text next to each lock checkbox. */
const LOCK_TEXT = 'Lock';

/**
 * The text the page shows next to each lock checkbox. It takes no group:
 * the text is the same whatever the group's name, so the lock column has
 * one width and the checkboxes sit in one column.
 */
export function lockText() {
  return LOCK_TEXT;
}

/**
 * The accessible name of a group's lock checkbox, for example
 * "Lock Headwear". The page writes it to the checkbox's `aria-label`, so a
 * screen reader says which group the lock is for. It starts with the
 * visible text, so somebody who speaks the visible text gets the control.
 * @param {Group} group
 */
export function lockAccessibleName(group) {
  return `${LOCK_TEXT} ${group.label}`;
}

/**
 * Whether a group gets a Lock. A group with one choice has nothing for
 * Randomize to change, so it gets none.
 * @param {Group} group
 */
export function hasLock(group) {
  return !hasOneChoice(group);
}

/**
 * The locks a style opens with: one per group that has a Lock, each of
 * them off. The page writes these when it builds the controls of a style,
 * so the locks of the style before it are gone.
 * @param {Manifest} manifest
 * @returns {Locks}
 */
export function startingLocks(manifest) {
  return Object.fromEntries(manifest.groups.filter(hasLock).map((group) => [group.id, false]));
}

/**
 * The ids of the style's groups that are locked, in draw order. A lock for a
 * group id the style doesn't have, or for a group without a Lock, is
 * ignored. Only `true` locks a group.
 * @param {Manifest} manifest
 * @param {Locks} locks
 * @returns {string[]}
 */
export function lockedGroupIds(manifest, locks) {
  return manifest.groups
    .filter((group) => hasLock(group) && Object.hasOwn(locks, group.id) && locks[group.id] === true)
    .map((group) => group.id);
}

/**
 * Whether Randomize has anything to pick. It has not when each group with a
 * Lock is locked, or when no group has one, and the page disables the
 * button then.
 * @param {Manifest} manifest
 * @param {Locks} locks
 */
export function canRandomize(manifest, locks) {
  const locked = new Set(lockedGroupIds(manifest, locks));
  return manifest.groups.some((group) => hasLock(group) && !locked.has(group.id));
}

/**
 * What Randomize picks: a new choice from all the choices of each unlocked
 * group, and the choice `selection` already has for each locked group,
 * "None" (`null`) included. A group with one choice keeps its pick too, and
 * gets its one option when `selection` has none for it. With no locks and
 * no such group this is `randomSelection`.
 * @param {Manifest} manifest
 * @param {Selection} selection the tiles picked now
 * @param {Locks} locks
 * @param {() => number} [random] returns a number in [0, 1), like Math.random
 * @returns {Selection}
 */
export function randomizeUnlocked(manifest, selection, locks, random = Math.random) {
  const locked = new Set(lockedGroupIds(manifest, locks));
  const next = {};
  for (const group of manifest.groups) {
    if (hasOneChoice(group)) next[group.id] = selection[group.id] ?? groupChoices(group)[0];
    else next[group.id] = locked.has(group.id) ? (selection[group.id] ?? null) : randomChoice(group, random);
  }
  return next;
}

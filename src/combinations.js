/**
 * Walking the selections a manifest allows. The render check uses these to
 * visit every trait combination, or a repeatable sample when there are too
 * many to visit.
 */
import { groupChoices } from './manifest.js';

/**
 * How many different selections the manifest allows. Returns Infinity when
 * the count is too large to hold exactly in a number.
 * @param {import('./manifest.js').Manifest} manifest
 * @returns {number}
 */
export function countCombinations(manifest) {
  let total = 1;
  for (const group of manifest.groups) {
    total *= groupChoices(group).length;
    if (!Number.isSafeInteger(total)) return Infinity;
  }
  return total;
}

/**
 * Every selection, in a fixed order: the last group changes fastest.
 * @param {import('./manifest.js').Manifest} manifest
 * @returns {Generator<import('./manifest.js').Selection>}
 */
export function* walkCombinations(manifest) {
  const groups = manifest.groups;
  const choices = groups.map(groupChoices);
  const indexes = new Array(groups.length).fill(0);
  while (true) {
    const selection = {};
    groups.forEach((group, i) => {
      selection[group.id] = choices[i][indexes[i]];
    });
    yield selection;
    let position = groups.length - 1;
    while (position >= 0) {
      indexes[position] += 1;
      if (indexes[position] < choices[position].length) break;
      indexes[position] = 0;
      position -= 1;
    }
    if (position < 0) return;
  }
}

/**
 * Small seeded random number generator (mulberry32), so a sampled check
 * visits the same selections on every run with the same seed.
 * @param {number} seed
 * @returns {() => number} numbers in [0, 1)
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` selections picked at random with a seed. The same selection can
 * come up more than once.
 * @param {import('./manifest.js').Manifest} manifest
 * @param {number} count
 * @param {number} seed
 * @returns {Generator<import('./manifest.js').Selection>}
 */
export function* sampleCombinations(manifest, count, seed) {
  const random = seededRandom(seed);
  const choices = manifest.groups.map(groupChoices);
  for (let n = 0; n < count; n += 1) {
    const selection = {};
    manifest.groups.forEach((group, i) => {
      selection[group.id] = choices[i][Math.floor(random() * choices[i].length)];
    });
    yield selection;
  }
}

/**
 * Walking the selections a manifest allows. The render check uses these to
 * visit every trait combination, or a repeatable sample of different
 * combinations when there are too many to visit.
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
 * A whole number in [0, limit), for limits up to Number.MAX_SAFE_INTEGER.
 * One draw from seededRandom carries 32 random bits, so larger limits use two.
 */
function randomBelow(random, limit) {
  if (limit <= 0x100000000) return Math.floor(random() * limit);
  const high = Math.floor(random() * 0x200000);
  const low = Math.floor(random() * 0x100000000);
  const value = Math.floor(((high * 0x100000000 + low) / 0x20000000000000) * limit);
  return Math.min(limit - 1, value);
}

/** The selection at `index` in walkCombinations order. */
function selectionAt(manifest, choices, index) {
  const selection = {};
  let rest = index;
  for (let i = manifest.groups.length - 1; i >= 0; i -= 1) {
    const size = choices[i].length;
    selection[manifest.groups[i].id] = choices[i][rest % size];
    rest = Math.floor(rest / size);
  }
  return selection;
}

/**
 * Up to `count` different selections picked at random with a seed. No
 * selection comes up twice, so every slot of a sampled check looks at a
 * different picture. When the manifest allows `count` selections or fewer,
 * this yields all of them.
 * @param {import('./manifest.js').Manifest} manifest
 * @param {number} count
 * @param {number} seed
 * @returns {Generator<import('./manifest.js').Selection>}
 */
export function* sampleCombinations(manifest, count, seed) {
  const total = countCombinations(manifest);
  if (total <= count) {
    yield* walkCombinations(manifest);
    return;
  }
  const random = seededRandom(seed);
  const choices = manifest.groups.map(groupChoices);

  if (Number.isFinite(total)) {
    // Floyd's algorithm: `count` distinct indexes out of `total`, in `count` draws.
    const picked = new Set();
    for (let top = total - count; top < total; top += 1) {
      const candidate = randomBelow(random, top + 1);
      const index = picked.has(candidate) ? top : candidate;
      picked.add(index);
      yield selectionAt(manifest, choices, index);
    }
    return;
  }

  // Too many selections to number them. Pick each group at random and skip repeats.
  const seen = new Set();
  while (seen.size < count) {
    const indexes = choices.map((list) => randomBelow(random, list.length));
    const key = indexes.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const selection = {};
    manifest.groups.forEach((group, i) => {
      selection[group.id] = choices[i][indexes[i]];
    });
    yield selection;
  }
}

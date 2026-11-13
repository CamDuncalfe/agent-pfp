import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { groupChoices, randomSelection, resolveSelection } from '../src/manifest.js';
import {
  canRandomize,
  hasLock,
  lockControlName,
  lockAccessibleName,
  lockText,
  lockedGroupIds,
  randomizeUnlocked,
  startingLocks,
} from '../src/locks.js';

async function loadFixture(name) {
  const url = new URL(`../fixtures/${name}/manifest.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

/** A `random` that walks through `values` and starts over at the end. */
function sequence(values) {
  let calls = 0;
  const random = () => {
    const value = values[calls % values.length];
    calls += 1;
    return value;
  };
  random.calls = () => calls;
  return random;
}

function allLocked(manifest) {
  return Object.fromEntries(manifest.groups.map((group) => [group.id, true]));
}

const groupIds = (manifest) => manifest.groups.map((group) => group.id);

test('the text next to each lock checkbox is "Lock" and takes no group', () => {
  assert.equal(lockText(), 'Lock');
  assert.equal(lockText.length, 0);
});

test("each lock checkbox's accessible name names its group", async () => {
  const manifest = await loadFixture('shapes');
  const headwear = manifest.groups.find((group) => group.id === 'headwear');
  assert.equal(lockAccessibleName(headwear), 'Lock Headwear');
  assert.equal(lockAccessibleName(manifest.groups.find((group) => group.id === 'eyes')), 'Lock Eyes');
  for (const group of manifest.groups) {
    assert.equal(lockAccessibleName(group), `Lock ${group.label}`);
    // The accessible name starts with the text on screen.
    assert.equal(lockAccessibleName(group).startsWith(lockText()), true);
  }
  const names = manifest.groups.map((group) => lockAccessibleName(group));
  assert.equal(new Set(names).size, manifest.groups.length);
});

test('a group with a long name gets the same "Lock" text and names itself to a screen reader', () => {
  const long = { id: 'background-accessories', label: 'Background accessories', options: [] };
  // The text has no group to read, so a long name can't change it.
  assert.equal(lockText(), 'Lock');
  assert.equal(lockAccessibleName(long), 'Lock Background accessories');
});

test('each group has a lock control name of its own', async () => {
  const manifest = await loadFixture('shapes');
  const lockNames = manifest.groups.map((group) => lockControlName(group.id));
  assert.equal(new Set(lockNames).size, manifest.groups.length);
  for (const name of lockNames) assert.equal(groupIds(manifest).includes(name), false);
});

test('Randomize keeps each locked group and picks each other group', async () => {
  const manifest = await loadFixture('shapes');
  const selection = { background: 'blue', body: 'square', eyes: 'bars', mouth: 'open', headwear: 'cap' };
  const locks = { ...startingLocks(manifest), eyes: true, headwear: true };

  const low = randomizeUnlocked(manifest, selection, locks, () => 0);
  assert.deepEqual(low, { background: 'grey', body: 'round', eyes: 'bars', mouth: 'line', headwear: 'cap' });
  const high = randomizeUnlocked(manifest, selection, locks, () => 0.999);
  assert.deepEqual(high, { background: 'blue', body: 'square', eyes: 'bars', mouth: 'open', headwear: 'cap' });
  assert.doesNotThrow(() => resolveSelection(manifest, low));
});

test('Randomize can pick any option of an unlocked group', async () => {
  const manifest = await loadFixture('shapes');
  const selection = randomSelection(manifest, () => 0);
  const locks = { ...startingLocks(manifest), body: true };
  const seen = new Map(manifest.groups.map((group) => [group.id, new Set()]));
  for (let step = 0; step < 100; step += 1) {
    const next = randomizeUnlocked(manifest, selection, locks, () => step / 100);
    for (const group of manifest.groups) seen.get(group.id).add(next[group.id]);
  }
  for (const group of manifest.groups) {
    const expected = group.id === 'body' ? [selection.body] : groupChoices(group);
    assert.deepEqual(seen.get(group.id), new Set(expected), group.id);
  }
});

test('Randomize does not use up a random number for a locked group', async () => {
  const manifest = await loadFixture('shapes');
  const selection = randomSelection(manifest, () => 0);
  const random = sequence([0.5]);
  randomizeUnlocked(manifest, selection, { background: true, mouth: true }, random);
  assert.equal(random.calls(), manifest.groups.length - 2);
});

test('Randomize leaves a locked group on None', async () => {
  const manifest = await loadFixture('shapes');
  const selection = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line', headwear: null };
  for (const value of [0, 0.5, 0.999]) {
    const next = randomizeUnlocked(manifest, selection, { headwear: true }, () => value);
    assert.equal(next.headwear, null);
    assert.doesNotThrow(() => resolveSelection(manifest, next));
  }
  // A selection may also leave an empty group out.
  const rest = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line' };
  assert.equal(randomizeUnlocked(manifest, rest, { headwear: true }, () => 0.999).headwear, null);
});

test('with no locks Randomize is randomSelection', async () => {
  const manifest = await loadFixture('shapes');
  const selection = { background: 'blue', body: 'square', eyes: 'bars', mouth: 'open', headwear: 'cap' };
  const values = [0.1, 0.9, 0.4, 0.7, 0.2, 0.999, 0];
  for (const locks of [{}, startingLocks(manifest)]) {
    assert.deepEqual(
      randomizeUnlocked(manifest, selection, locks, sequence(values)),
      randomSelection(manifest, sequence(values)),
    );
  }
});

test('a locked group changed with its picker keeps the new option and its lock', async () => {
  const manifest = await loadFixture('shapes');
  const locks = Object.freeze({ ...startingLocks(manifest), headwear: true });
  const before = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line', headwear: 'cap' };
  assert.equal(randomizeUnlocked(manifest, before, locks, () => 0).headwear, 'cap');

  // The picker changes the selection. Nothing changes the locks.
  const after = Object.freeze({ ...before, headwear: 'tall' });
  assert.equal(randomizeUnlocked(manifest, after, locks, () => 0).headwear, 'tall');
  assert.deepEqual(lockedGroupIds(manifest, locks), ['headwear']);
});

test('a style opens with each lock off', async () => {
  for (const name of ['shapes', 'blocks']) {
    const manifest = await loadFixture(name);
    const locks = startingLocks(manifest);
    assert.deepEqual(Object.keys(locks), groupIds(manifest));
    assert.deepEqual(lockedGroupIds(manifest, locks), []);
    assert.equal(canRandomize(manifest, locks), true);
  }
});

test('Randomize is off while each group is locked and on again when one is unlocked', async () => {
  const manifest = await loadFixture('shapes');
  const locks = startingLocks(manifest);
  for (const group of manifest.groups) {
    assert.equal(canRandomize(manifest, locks), true);
    locks[group.id] = true;
  }
  assert.equal(canRandomize(manifest, locks), false);
  locks.mouth = false;
  assert.equal(canRandomize(manifest, locks), true);
});

test('with each group locked Randomize changes nothing', async () => {
  const manifest = await loadFixture('shapes');
  const selection = { background: 'blue', body: 'square', eyes: 'bars', mouth: 'open', headwear: null };
  const random = sequence([0]);
  assert.deepEqual(randomizeUnlocked(manifest, selection, allLocked(manifest), random), selection);
  assert.equal(random.calls(), 0);
});

test('a lock for a group the style does not have is ignored', async () => {
  const manifest = await loadFixture('shapes');
  const selection = randomSelection(manifest, () => 0);
  const locks = { tail: true, toString: true, eyes: true };
  assert.deepEqual(lockedGroupIds(manifest, locks), ['eyes']);

  const next = randomizeUnlocked(manifest, selection, locks, () => 0.999);
  assert.deepEqual(Object.keys(next), groupIds(manifest));
  assert.equal(next.eyes, selection.eyes);
  assert.doesNotThrow(() => resolveSelection(manifest, next));

  // Unknown locks don't count towards "each group is locked".
  const oneOpen = { ...allLocked(manifest), eyes: false, tail: true };
  assert.equal(canRandomize(manifest, oneOpen), true);
  assert.equal(canRandomize(manifest, { ...allLocked(manifest), tail: true }), false);
});

/** The shapes fixture with one body, like the alien's one Character. */
async function loadOneBody() {
  const manifest = await loadFixture('shapes');
  const body = manifest.groups.find((group) => group.id === 'body');
  body.options = [body.options[0]];
  return manifest;
}

test('a group with one option and no None gets no Lock', async () => {
  const manifest = await loadOneBody();
  const byId = (id) => manifest.groups.find((group) => group.id === id);
  assert.equal(hasLock(byId('body')), false);
  for (const id of ['background', 'eyes', 'mouth', 'headwear']) assert.equal(hasLock(byId(id)), true, id);
  assert.deepEqual(Object.keys(startingLocks(manifest)), ['background', 'eyes', 'mouth', 'headwear']);
  // An optional group with one option has two choices, so it keeps its Lock.
  assert.equal(hasLock({ ...byId('headwear'), options: [byId('headwear').options[0]] }), true);
  // The alien's Character is such a group.
  const alien = JSON.parse(await readFile(new URL('../styles/alien/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(alien.groups.filter((group) => !hasLock(group)).map((group) => group.id), ['character']);
});

test('Randomize leaves a one-choice group on its option and uses no random number for it', async () => {
  const manifest = await loadOneBody();
  const selection = { background: 'grey', body: 'round', eyes: 'dots', mouth: 'line', headwear: null };
  for (const value of [0, 0.5, 0.999]) {
    const random = sequence([value]);
    const next = randomizeUnlocked(manifest, selection, startingLocks(manifest), random);
    assert.equal(next.body, 'round');
    assert.equal(random.calls(), manifest.groups.length - 1);
    // Its layer is still drawn and listed.
    assert.ok(resolveSelection(manifest, next).some((layer) => layer.group.id === 'body'));
  }
  // A selection that leaves it out gets its one option.
  const { body, ...rest } = selection;
  assert.equal(randomizeUnlocked(manifest, rest, {}, () => 0.5).body, body);
});

test('Randomize is off once each group with a Lock is locked, and a lock on a one-choice group is ignored', async () => {
  const manifest = await loadOneBody();
  const locks = { background: true, eyes: true, mouth: true, headwear: true };
  assert.equal(canRandomize(manifest, locks), false);
  assert.equal(canRandomize(manifest, { ...locks, mouth: false }), true);
  assert.deepEqual(lockedGroupIds(manifest, { body: true }), []);
  // A style whose groups all have one choice has nothing to randomize.
  const only = { ...manifest, groups: [manifest.groups.find((group) => group.id === 'body')] };
  assert.equal(canRandomize(only, startingLocks(only)), false);
});

test('only true locks a group', async () => {
  const manifest = await loadFixture('shapes');
  const locks = { eyes: 'yes', mouth: 1, body: false, background: true };
  assert.deepEqual(lockedGroupIds(manifest, locks), ['background']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The builder page has no DOM to run in here. These tests read its source
 * and check the parts the layout of the trait rows depends on.
 */

const read = (path) => readFile(new URL(`../web/${path}`, import.meta.url), 'utf8');

/** Each rule of a stylesheet as { selectors, body }, comments left out. */
function rules(css) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map((item) => item.trim()),
    body,
  }));
}

/** The declarations of each rule with exactly this selector, as [property, value] pairs. */
function declarations(css, selector) {
  const found = [];
  for (const rule of rules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    for (const line of rule.body.split(';')) {
      const colon = line.indexOf(':');
      if (colon !== -1) found.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return found;
}

/** Split a track list at the spaces outside brackets. */
function tracks(value) {
  const list = [];
  let depth = 0;
  let track = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (track) list.push(track);
      track = '';
    } else {
      track += char;
    }
  }
  if (track) list.push(track);
  return list;
}

/**
 * A length that doesn't depend on what is in the column and grows with the
 * text size, for example 4.5em. A px length stays put when the user enlarges
 * the text, and the word "Lock" would run out of the column.
 */
const FIXED_LENGTH = /^\d+(\.\d+)?(em|rem)$/;

test('each trait row uses the same two columns and the lock column has one width that grows with the text', async () => {
  const css = await read('builder.css');

  // One rule sets the columns of a trait row, so each row gets the same ones.
  const columnRules = rules(css).filter(
    (rule) => rule.selectors.some((item) => /\.trait\b/.test(item)) && /(^|;)\s*grid[\w-]*\s*:/.test(rule.body),
  );
  assert.equal(columnRules.length, 1, 'one rule sets the grid of .trait');
  assert.deepEqual(columnRules[0].selectors, ['.trait']);

  const trait = Object.fromEntries(declarations(css, '.trait'));
  assert.equal(trait.display, 'grid');
  const [picker, lock, ...rest] = tracks(trait['grid-template-columns']);
  assert.deepEqual(rest, [], 'two columns');
  assert.equal(picker, 'minmax(0, 1fr)', 'the picker takes the width that is left');

  // The lock column is a length, straight or through one custom property.
  // "auto", "max-content", "min-content" and "fit-content()" would size it to the text.
  const variable = /^var\((--[\w-]+)\)$/.exec(lock);
  const width = variable ? Object.fromEntries(declarations(css, ':root'))[variable[1]] : lock;
  assert.match(width ?? '', FIXED_LENGTH, `lock column width "${width}"`);
  if (variable) {
    const sets = rules(css).filter((rule) => new RegExp(`(^|;)\\s*${variable[1]}\\s*:`).test(rule.body));
    assert.equal(sets.length, 1, `${variable[1]} is set once, so no row changes it`);
  }
});

test('the lock text stays on one line and the lock label sets no width of its own', async () => {
  const lock = Object.fromEntries(declarations(await read('builder.css'), 'label.lock'));
  assert.equal(lock['white-space'], 'nowrap');
  assert.equal(lock.width, undefined);
  assert.equal(lock['min-width'], undefined);
});

test('the page takes the lock text and the aria-label from src/locks.js', async () => {
  const js = await read('builder.js');
  assert.match(js, /checkbox\.setAttribute\('aria-label', lockAccessibleName\(group\)\)/);
  assert.match(js, /lock\.append\(checkbox, lockText\(\)\)/);
  // No row gets an inline style of its own.
  assert.doesNotMatch(js, /\.style\./);
  assert.doesNotMatch(js, /\.style\s*=/);
});

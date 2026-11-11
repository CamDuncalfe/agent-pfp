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

test('Randomize, the Size picker and Download each take a line of their own at each width', async () => {
  const css = await read('builder.css');

  // One rule lays out the controls under the preview, and no other rule changes it for some width.
  const layoutRules = rules(css).filter((rule) => rule.selectors.some((item) => /\.actions\b/.test(item)));
  assert.equal(layoutRules.length, 1, 'one rule sets the layout of .actions');
  assert.deepEqual(layoutRules[0].selectors, ['.actions']);
  assert.doesNotMatch(css, /@media[^{]*\{[^}]*\.actions/, 'no media query changes it');

  // A grid with one column puts each control on the next line, however wide the column is.
  const actions = Object.fromEntries(declarations(css, '.actions'));
  assert.equal(actions.display, 'grid');
  assert.deepEqual(tracks(actions['grid-template-columns']), ['minmax(0, 1fr)'], 'one column');
  assert.equal(actions['grid-auto-flow'], undefined, 'controls flow down the column');
  assert.equal(actions['flex-wrap'], undefined);

  // The buttons keep their own width and the picker takes the whole line.
  assert.equal(actions['justify-items'], 'start');
  const picker = Object.fromEntries(declarations(css, 'label.size-picker'));
  assert.equal(picker['justify-self'], 'stretch');
  assert.equal(picker['grid-column'], undefined);
  assert.equal(picker.width, undefined);

  // The order on the page is the order down the column.
  const html = await read('index.html');
  const controls = /<div class="actions">([\s\S]*?)<\/div>/.exec(html)[1];
  const order = [...controls.matchAll(/<(?:button|select)[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['randomize', 'size', 'download']);
});

test('the Size picker sits right above Download, lists Full size first and starts disabled', async () => {
  const html = await read('index.html');
  const actions = /<div class="actions">([\s\S]*?)<\/div>/.exec(html)[1];
  const picker = actions.indexOf('<select id="size" disabled>');
  const button = actions.indexOf('<button type="button" id="download"');
  assert.notEqual(picker, -1, 'the picker is with the buttons and starts disabled');
  assert.ok(picker < button, 'the picker comes right before Download');
  assert.doesNotMatch(actions.slice(picker, button), /<button/, 'no button sits between them');
  assert.match(actions, /<label class="size-picker">\s*Size\s*<select id="size"/);

  // Before a style opens the picker holds Full size, under the id src/download.js gives it.
  const { FULL_SIZE } = await import('../src/download.js');
  const options = [...actions.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(options, [[FULL_SIZE.id, FULL_SIZE.label]]);
});

test('the Size picker is disabled whenever Download is', async () => {
  const js = await read('builder.js');
  // One function sets both, from the same value, and nothing else sets either.
  assert.match(js, /downloadEl\.disabled = picture === null;\n\s*sizeEl\.disabled = picture === null;/);
  assert.equal(js.match(/downloadEl\.disabled\s*=/g).length, 1);
  assert.equal(js.match(/sizeEl\.disabled\s*=/g).length, 1);
});

test('the page takes the sizes, the saved picture and the file name from src/download.js', async () => {
  const js = await read('builder.js');
  assert.match(js, /sizePicker\(manifest\.canvas, sizeEl\.value\)/);
  assert.match(js, /planDownload\(manifest, sizeEl\.value\)/);
  assert.match(js, /pictureToSave\(finished, plan\)/);
  assert.match(js, /link\.download = plan\.fileName;/);
  // The page holds no size, no file name and no scaling of its own.
  assert.doesNotMatch(js, /agent-pfp-|\.png|\b500\b|scaleDown/);
});

test('Full size saves the preview canvas as it is, and a failed PNG is reported', async () => {
  const js = await read('builder.js');
  assert.match(js, /if \(!plan\.scaled\) return previewEl;/);
  assert.match(js, /canvasToSave\(plan\)\.toBlob\(/);
  assert.match(js, /'image\/png'/);
  assert.match(js, /setStatus\('Could not make the PNG file\.', true\)/);
});

test('compositeLayers draws the picture once and nothing else stacks layers', async () => {
  const js = await read('builder.js');
  assert.equal(js.match(/compositeLayers\(/g).length, 1, 'the page composites in one place');
  // The one drawImage is the layer loader, at 0,0 with no size.
  assert.deepEqual(js.match(/drawImage\([^)]*\)/g), ['drawImage(bitmap, 0, 0)']);
  assert.doesNotMatch(js, /globalCompositeOperation|\.scale\(|setTransform/);

  // The download and scaling modules take a finished picture. Neither composites.
  for (const name of ['download.js', 'scale.js']) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /compositeLayers\(|^import[^;]*compositeLayers/m, name);
  }
});

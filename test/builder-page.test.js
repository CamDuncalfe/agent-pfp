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

test('each trait heading uses the same two columns and the lock column has one width that grows with the text', async () => {
  const css = await read('builder.css');

  // One rule sets the columns of a trait heading, so each heading gets the same ones.
  const columnRules = rules(css).filter(
    (rule) =>
      rule.selectors.some((item) => /\.trait-heading\b/.test(item)) && /(^|;)\s*grid-template[\w-]*\s*:/.test(rule.body),
  );
  assert.equal(columnRules.length, 1, 'one rule sets the columns of .trait-heading');
  assert.deepEqual(columnRules[0].selectors, ['.trait-heading']);

  const trait = Object.fromEntries(declarations(css, '.trait-heading'));
  assert.equal(trait.display, 'grid');
  const [name, lock, ...rest] = tracks(trait['grid-template-columns']);
  assert.deepEqual(rest, [], 'two columns');
  assert.equal(name, 'minmax(0, 1fr)', 'the name takes the width that is left');

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
  assert.equal(js.match(/drawImage\(/g), null, 'the page draws no image itself');
  // The one drawImage is the layer loader the page and the thumbnail worker share, at 0,0 with no size.
  const loader = await read('layers.js');
  assert.deepEqual(loader.match(/drawImage\([^)]*\)/g), ['drawImage(bitmap, 0, 0)']);
  assert.match(loader, /loadLayerPixels\(resolveLayerUrl\(src, manifestUrl\), manifest\.canvas\)/);
  // The worker draws with src/thumbnails.js, which composites with compositeLayers, and loads through layers.js.
  const worker = await read('thumbnail-worker.js');
  assert.equal(worker.match(/compositeLayers|drawImage|fetch\(/g), null);
  assert.match(worker, /from '\.\/layers\.js'/);
  for (const source of [js, loader, worker]) {
    assert.doesNotMatch(source, /globalCompositeOperation|\.scale\(|setTransform/);
  }

  // The download and scaling modules take a finished picture. Neither composites.
  for (const name of ['download.js', 'scale.js']) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /compositeLayers\(|^import[^;]*compositeLayers/m, name);
  }
});

test('each group gets a grid of tiles and no dropdown', async () => {
  const js = await read('builder.js');
  const html = await read('index.html');
  // The two dropdowns on the page are the Style picker and the Size picker.
  assert.deepEqual([...html.matchAll(/<select id="([^"]+)"/g)].map((match) => match[1]), ['style', 'size']);
  assert.equal(js.match(/createElement\('select'\)/g), null, 'the page makes no dropdown');
  // One tile per entry of traitTiles, each a radio button named after its group.
  assert.match(js, /traitTiles\(group\)\.forEach\(\(tile, index\) =>/);
  assert.match(js, /input\.type = 'radio';\n\s*input\.name = group\.id;\n\s*input\.value = tile\.value;/);
  assert.match(js, /grid\.className = 'tiles';/);
});

test('each grid is a radio group named by its heading, and each tile is named by its option label', async () => {
  const js = await read('builder.js');
  const css = await read('builder.css');
  assert.match(js, /grid\.setAttribute\('role', 'radiogroup'\);/);
  assert.match(js, /grid\.setAttribute\('aria-labelledby', title\.id\);/);
  assert.match(js, /title\.id = `trait-\$\{group\.id\}`;/);
  // The radio button sits in the tile's label with the option's label as its text. The canvas is hidden from screen readers.
  assert.match(js, /name\.textContent = tile\.label;/);
  assert.match(js, /label\.append\(input, thumb, name\);/);
  assert.match(js, /thumb\.setAttribute\('aria-hidden', 'true'\);/);
  // The radio button is hidden by opacity, not display or visibility, so Tab and the arrow keys still reach it.
  const input = Object.fromEntries(declarations(css, 'label.tile input'));
  assert.equal(input.opacity, '0');
  assert.equal(input.display, undefined);
  assert.equal(input.visibility, undefined);
  const name = Object.fromEntries(declarations(css, '.tile-name'));
  assert.equal(name.display, undefined, 'the hidden label stays in the accessibility tree');
  assert.equal(name.visibility, undefined);
});

test('a click on a tile redraws the preview, the round preview and the layer list', async () => {
  const js = await read('builder.js');
  // A radio change renders. Only a lock checkbox skips the render.
  assert.match(
    js,
    /if \(event\.target instanceof HTMLInputElement && event\.target\.type === 'checkbox'\) updateRandomize\(\);\n\s*else current\?\.render\(\);/,
  );
  // The render reads the picked tiles and writes both previews and the list.
  assert.match(js, /const selection = readSelection\(manifest\);\n\s*const layers = resolveSelection\(manifest, selection\);\n\s*showSelection\(layers\);/);
  assert.match(js, /putPicture\(previewEl, picture\);\n\s*putPicture\(roundPreviewEl, roundPreviewPicture\(picture\)\);/);
  assert.match(js, /picked \? choiceFromValue\(picked\.value\) : null/);
});

test('the thumbnails are drawn in a worker after each render, and the page paints a whole group at once', async () => {
  const js = await read('builder.js');
  assert.match(js, /new Worker\(new URL\('thumbnail-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.match(js, /requestThumbnails\(selection\);/);
  assert.match(js, /if \(!redraws\.needsRedraw\(group\.id, key\)\) continue;/);
  // An answer for an older request is dropped.
  assert.match(js, /if \(answer\.ticket !== thumbnailTicket \|\| !isOnScreen\(\)\) return;/);
  // The group's key is cleared before the first tile is painted and set after the last one.
  const paint = /redraws\.start\(answer\.groupId\);([\s\S]*?)redraws\.finish\(answer\.groupId, answer\.key\);/.exec(js);
  assert.ok(paint, 'start, then the tiles, then finish');
  assert.match(paint[1], /for \(const tile of answer\.tiles\)/);
  assert.match(paint[1], /putPicture\(canvasEl, tile\);/);
  assert.doesNotMatch(paint[1], /await/, 'the tiles of a group are painted in one go');

  const worker = await read('thumbnail-worker.js');
  assert.match(worker, /drawThumbnail\(\{ manifest, selection, group, choice: tile\.choice, pixelsOf, boundsOf \}\)/);
  // The worker drops a request once a newer one has come, also halfway through a group, and sends a group's tiles in one answer.
  assert.match(worker, /if \(request\.ticket < latest\) return null;/);
  assert.match(worker, /self\.postMessage\(\{ type: 'tiles', ticket, groupId, key, tiles \}/);
  assert.match(worker, /createLayerLoader\(manifest, manifestUrl, THUMBNAIL_LAYER_BYTES\)/);
});

test('the page keeps the layers of the picture on screen up to its limit', async () => {
  const js = await read('builder.js');
  assert.match(js, /createLayerLoader\(manifest, baseUrl, PAGE_LAYER_BYTES\)/);
  assert.doesNotMatch(js, /new Map\(\);\n\s*let latest/, 'no cache without a limit');
});

test('Lock sits in the heading row of its group and Randomize checks the tiles it picks', async () => {
  const js = await read('builder.js');
  assert.match(js, /heading\.className = 'trait-heading';/);
  assert.match(js, /heading\.append\(title, lock\);/);
  assert.match(js, /row\.append\(heading, grid\);/);
  // Randomize keeps the locked groups, then checks the tile of each choice and redraws.
  assert.match(
    js,
    /writeSelection\(manifest, randomizeUnlocked\(manifest, readSelection\(manifest\), locks\)\);\n\s*current\.render\(\);/,
  );
  assert.match(js, /for \(const input of tileInputs\(group\)\) input\.checked = input\.value === value;/);
});

test('the picked tile shows a check mark and a second ring, not only another colour', async () => {
  const css = await read('builder.css');
  const picked = Object.fromEntries(declarations(css, 'label.tile:has(input:checked)'));
  assert.ok(picked['box-shadow'], 'a second ring around the frame');
  const mark = Object.fromEntries(declarations(css, 'label.tile:has(input:checked)::after'));
  assert.equal(mark.content, "'✓'");
  assert.equal(mark.position, 'absolute');
  // The mark sits inside the tile, so it never sticks out of the column.
  assert.ok(Number.parseFloat(mark.top) >= 0 && Number.parseFloat(mark.right) >= 0);
  const focus = Object.fromEntries(declarations(css, 'label.tile:has(input:focus-visible)'));
  assert.match(focus.outline ?? '', /solid/, 'a focused tile has an outline');
});

test('at 390 px the tiles wrap inside the column', async () => {
  const css = await read('builder.css');
  const tiles = Object.fromEntries(declarations(css, '.tiles'));
  assert.equal(tiles.display, 'flex');
  assert.equal(tiles['flex-wrap'], 'wrap');
  // Under 560 px the page has one column: 390 px less 24 px of padding a side.
  assert.match(css, /@media \(max-width: 560px\)\s*\{\s*\.layout\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.equal(Object.fromEntries(declarations(css, 'main')).padding, '40px 24px 64px');
  const column = 390 - 2 * 24;
  // A tile is the thumbnail, 2 px of padding and a 2 px border a side.
  const thumbnail = Number.parseFloat(Object.fromEntries(declarations(css, ':root'))['--thumbnail']);
  const tile = Object.fromEntries(declarations(css, 'label.tile'));
  assert.equal(tile.padding, '2px');
  assert.match(tile.border, /^2px /);
  assert.ok(thumbnail + 8 <= column, 'a tile fits the column at 390 px');
  // Nothing in a trait row sets a width that could push past the column.
  for (const selector of ['.trait', '.trait-heading', '.tiles', 'label.tile']) {
    const rule = Object.fromEntries(declarations(css, selector));
    assert.equal(rule.width, undefined, selector);
    assert.equal(rule['min-width'] ?? '0', '0', selector);
  }
});

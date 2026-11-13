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

const plain = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the page takes the lock text and the aria-label from src/locks.js and sets no inline style', async () => {
  const js = await read('builder.js');
  assert.match(js, /checkbox\.setAttribute\('aria-label', lockAccessibleName\(group\)\);/);
  assert.match(js, /text\.textContent = lockText\(\);/);
  assert.match(js, /lock\.append\(checkbox, icon, text\);/);
  assert.doesNotMatch(js, /\.style\./);
  assert.doesNotMatch(js, /\.style\s*=/);
});

test('the page has three buttons under the preview: Randomize, Download image and Reset', async () => {
  const html = await read('index.html');
  const actions = /<div class="actions">([\s\S]*?)<\/div>/.exec(html)[1];
  const buttons = [...actions.matchAll(/<button type="button" id="([^"]+)" class="([^"]+)" disabled>[\s\S]*?<\/svg>\s*([^<]+?)\s*<\/button>/g)].map(
    (match) => [match[1], match[2], match[3]],
  );
  assert.deepEqual(buttons, [
    ['randomize', 'button primary', 'Randomize'],
    ['download', 'button', 'Download image'],
    ['reset', 'button quiet', 'Reset'],
  ]);
  // Each icon is hidden from screen readers, so the text is the button's name.
  assert.equal(actions.match(/<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">/g).length, 3);
});

test('the Size picker sits under the buttons, starts hidden and disabled, and is disabled whenever Download is', async () => {
  const html = await read('index.html');
  assert.match(html, /<\/div>\s*<fieldset id="size" class="size-picker" hidden disabled>\s*<legend>Size<\/legend>\s*<\/fieldset>/);
  const js = await read('builder.js');
  // One function sets both, from the same value, and nothing else sets either.
  assert.match(js, /downloadEl\.disabled = picture === null;\n\s*sizeEl\.disabled = picture === null;/);
  assert.equal(js.match(/downloadEl\.disabled\s*=/g).length, 1);
  assert.equal(js.match(/sizeEl\.disabled\s*=/g).length, 1);
  // A style with one size gets no picker.
  assert.match(js, /const \{ options, value, shown \} = sizePicker\(manifest\.canvas, pickedSize\(\)\);/);
  assert.match(js, /sizeEl\.hidden = !shown;/);
  // The sizes are radio buttons of one name no group can have, since a group id has no colon.
  assert.match(js, /const SIZE_NAME = 'download:size';/);
  assert.match(js, /input\.type = 'radio';\n\s*input\.name = SIZE_NAME;/);
});

test('the page takes the sizes, the saved picture and the file name from src/download.js', async () => {
  const js = await read('builder.js');
  assert.match(js, /planDownload\(manifest, pickedSize\(\)\)/);
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

test('the type comes from one Adobe Fonts kit, and the page loads nothing else from another origin', async () => {
  const html = await read('index.html');
  // The one link to another origin is the kit's stylesheet, before the page's own.
  const external = [...html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(external, ['https://use.typekit.net/dll3tpt.css']);
  assert.ok(html.indexOf('use.typekit.net') < html.indexOf('href="builder.css"'), 'the kit comes first');
  // The stylesheet loads no font file of its own, and its only images are inline.
  const css = plain(await read('builder.css'));
  assert.doesNotMatch(css, /@font-face|@import/);
  for (const [, url] of css.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.match(url, /^data:/);
  // Neue Haas Grotesk Text for the page, then the system face while the kit loads or when it can't. No free font in the stack.
  assert.match(css, /body \{[^}]*font-family: 'neue-haas-grotesk-text', system-ui, -apple-system, 'Segoe UI', sans-serif;/);
  // Owners Narrow is the face of the wordmark and the headings, through one custom property, in Bold.
  assert.match(css, /--font-head: 'owners-narrow', system-ui, -apple-system, 'Segoe UI', sans-serif;/);
  assert.equal(css.match(/owners-narrow/g).length, 1);
  const headed = rules(css).filter((rule) => /font-family:\s*var\(--font-head\)/.test(rule.body));
  assert.deepEqual(headed.map((rule) => rule.selectors.join(', ')).sort(), ['.trait-heading h2', '.wordmark', 'h1']);
  for (const rule of headed) assert.match(rule.body, /font-weight:\s*700;/, rule.selectors.join(', '));
  // The kit holds Neue Haas Grotesk Text in 400, 500 and 700, so the page uses those weights only.
  const weights = new Set([...css.matchAll(/font-weight:\s*(\d+)/g)].map((match) => match[1]));
  assert.deepEqual([...weights].sort(), ['400', '500', '700']);
});

test('the logo is the wordmark, with no image, and the name is written in src/brand.js only', async () => {
  const html = await read('index.html');
  assert.match(html, /<header class="topbar">\s*<p id="wordmark" class="wordmark"><\/p>\s*<\/header>/);
  assert.doesNotMatch(html, /<img/);
  const { NAME, pageTitle } = await import('../src/brand.js');
  assert.equal(NAME, 'Agent PFP');
  assert.equal(pageTitle(NAME), 'Agent PFP builder');
  // The page writes the name into the wordmark and the title from src/brand.js, and no page file holds it.
  const js = await read('builder.js');
  assert.match(js, /document\.querySelector\('#wordmark'\)\.textContent = NAME;\n\s*document\.title = pageTitle\(NAME\);/);
  assert.match(js, /async function start\(\) \{\n\s*showName\(\);/);
  for (const file of ['index.html', 'builder.js', 'builder.css', 'thumbnail-worker.js', 'layers.js']) {
    assert.doesNotMatch(await read(file), new RegExp(NAME), file);
  }
});

test('the character row has one tile per style in the index, as a radio group, and replaces the Style dropdown', async () => {
  const html = await read('index.html');
  assert.match(html, /<h2 id="bases-heading" class="bases-heading">Character<\/h2>/);
  assert.match(html, /<div id="bases" class="base-list" role="radiogroup" aria-labelledby="bases-heading"><\/div>/);
  assert.match(html, /<p class="bases-note">More characters on the way\.<\/p>/);
  // The row sits above the builder, outside the form, so picking a style never reads as a trait.
  assert.ok(html.indexOf('id="bases"') < html.indexOf('<form id="controls"'));
  const js = await read('builder.js');
  assert.match(js, /buildBaseRow\(index\.styles\);/);
  assert.match(js, /input\.type = 'radio';\n\s*input\.name = BASE_NAME;\n\s*input\.value = entry\.id;/);
  assert.match(js, /name\.textContent = entry\.name;/);
  assert.match(js, /const BASE_NAME = 'style:base';/);
  // Picking a tile opens its style, and opening a style checks its tile.
  assert.match(js, /const entry = index\.styles\.find\(\(candidate\) => candidate\.id === target\.value\);\n\s*if \(entry\) switcher\.open\(entry\);/);
  assert.match(js, /const input = baseInput\(entry\.id\);\n\s*if \(input\) input\.checked = true;/);
  // A tile shows the picture the style opens with. The page asks the thumbnail worker for it after the
  // first style is on screen, and the worker draws it with basePicture from src/builder-layout.js.
  assert.match(js, /await switcher\.open\(entry\);\n\s*await drawBaseTiles\(index\.styles\);/);
  assert.match(js, /worker\.postMessage\(\{ kind: 'base', id: entry\.id, manifest, manifestUrl: String\(url\) \}\);/);
  assert.match(js, /if \(event\.data\.type === 'base'\) paintBaseTile\(event\.data\);/);
  assert.doesNotMatch(js, /basePicture|baseLayers/, 'the main thread composites no tile picture');
  const worker = await read('thumbnail-worker.js');
  assert.match(worker, /return basePicture\(manifest, \(src\) => loaded\.get\(src\)\);/);
  // The style on screen reuses the layers its thumbnails loaded. The decision is reusesThumbnailLayers in src/builder-layout.js.
  assert.match(worker, /reusesThumbnailLayers\(style\?\.manifestUrl \?\? null, manifestUrl\)\s*\? style\.layers\s*: createLayerLoader\(manifest, manifestUrl, THUMBNAIL_LAYER_BYTES\)/);
  // A tile request has no ticket and a queue of its own, so it neither drops nor is dropped by a thumbnail request.
  assert.match(worker, /if \(request\.kind === 'base'\) \{\n\s*baseQueue\.push\(request\);\n\s*if \(!basesRunning\) runBases\(\);\n\s*return;\n\s*\}\n\s*latest = Math\.max\(latest, request\.ticket\);/);
  // Trait thumbnails go first: the thumbnail loop never draws a character picture, and a character picture
  // composites only while no thumbnail request is running or waiting.
  const run = /async function run\(\) \{([\s\S]*?)\n\}/.exec(worker)[1];
  assert.doesNotMatch(run, /drawBase|base/);
  // The decision is mayDrawBase in src/builder-layout.js (test/builder-layout.test.js); the worker calls it before compositing.
  assert.match(worker, /while \(!mayDrawBase\(\{ running, waiting: queue\.length \}\)\) await nextTask\(\);\n\s*return basePicture\(/);
  // The tile picture is hidden from screen readers, and the style's name is the radio button's name.
  assert.match(js, /thumb\.className = 'base-thumb';[\s\S]{0,120}thumb\.setAttribute\('aria-hidden', 'true'\);/);
  const css = await read('builder.css');
  assert.equal(Object.fromEntries(declarations(css, 'label.base input')).opacity, '0');
  assert.ok(Object.fromEntries(declarations(css, 'label.base:has(input:checked)'))['box-shadow'], 'the picked tile has a shadow');
  assert.equal(Object.fromEntries(declarations(css, 'label.base:has(input:checked)::after')).content, "'✓'");
  // When the tiles don't fit, the row scrolls sideways.
  assert.equal(Object.fromEntries(declarations(css, '.base-list'))['overflow-x'], 'auto');
});

test('each group gets tiles and no dropdown', async () => {
  const js = await read('builder.js');
  const html = await read('index.html');
  // The page has no dropdown. Styles are tiles in the character row.
  assert.doesNotMatch(html, /<select/);
  assert.equal(js.match(/createElement\('select'\)/g), null, 'the page makes no dropdown');
  // One tile per entry of traitTiles, each a radio button named after its group. The first one starts picked.
  assert.match(js, /traitTiles\(group\)\.forEach\(\(tile, index\) => grid\.append\(makeTile\(group, tile, index === 0, tileClass, pixelArt\)\)\);/);
  assert.match(js, /input\.type = 'radio';\n\s*input\.name = group\.id;\n\s*input\.value = tile\.value;/);
});

test('each grid is a radio group named by its heading, and each tile is named by its option label', async () => {
  const js = await read('builder.js');
  const css = await read('builder.css');
  assert.match(js, /grid\.setAttribute\('role', 'radiogroup'\);\n\s*grid\.setAttribute\('aria-labelledby', labelId\);/);
  // The panel's heading and the swatch column's hidden heading both have the id the grid points at.
  assert.equal(js.match(/title\.id = `trait-\$\{group\.id\}`;/g).length, 2);
  assert.match(js, /makeGrid\(group, 'swatch-list', 'tile swatch', title\.id, pixelArt\)/);
  assert.match(js, /makeGrid\(group, 'tiles', 'tile', title\.id, pixelArt\)/);
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

test('the background group is a column of swatches on the left of the preview', async () => {
  const html = await read('index.html');
  const row = /<div class="stage-row">([\s\S]*?)<div class="actions">/.exec(html)[1];
  assert.ok(row.indexOf('id="swatches"') < row.indexOf('class="stage-card"'), 'the column comes first, on the left');
  const js = await read('builder.js');
  assert.match(js, /buildSwatches\(swatchGroup\(manifest\), locks, pixelArt\);/);
  // The column is as tall as the preview: it takes no height of its own and scrolls when a style has more colours.
  const css = await read('builder.css');
  const column = Object.fromEntries(declarations(css, '.swatches'));
  assert.equal(column.contain, 'size');
  assert.equal(column['flex-direction'], 'column');
  // When the swatches don't fit, only the list scrolls, with a scrollbar, and the Lock stays in view at the foot.
  assert.equal(column.overflow, 'hidden');
  const list = Object.fromEntries(declarations(css, '.swatch-list'));
  assert.equal(list['overflow-y'], 'auto');
  assert.equal(list['min-height'], '0');
  assert.match(list.flex, /^0 1 /, 'the list shrinks, the Lock does not');
  assert.notEqual(list['scrollbar-width'], 'none', 'the scrollbar shows');
  assert.equal(Object.fromEntries(declarations(css, 'label.lock.compact')).flex, 'none');
  const grid = Object.fromEntries(declarations(css, '.stage-row'));
  assert.deepEqual(tracks(grid['grid-template-columns']), ['calc(var(--swatch) + 12px)', 'minmax(0, 1fr)']);
  // The picked swatch has two rings, so it doesn't show by colour alone.
  assert.match(Object.fromEntries(declarations(css, 'label.swatch:has(input:checked)'))['box-shadow'], /var\(--ink\)/);
});

test('ten swatches and the Lock fit beside the preview at 390 px, with room for each ring', async () => {
  const css = plain(await read('builder.css'));
  const phone = /@media \(max-width: 560px\) \{\s*:root \{([^}]*)\}/.exec(css)[1];
  const value = (name) => Number.parseFloat(new RegExp(`--${name}:\\s*([\\d.]+)px`).exec(phone)[1]);
  const [swatch, gap, ring] = [value('swatch'), value('swatch-gap'), value('ring')];
  const reach = Number.parseFloat(/--swatch-reach:\s*([\d.]+)px/.exec(css)[1]);
  const rowGap = Number.parseFloat(/@media \(max-width: 560px\)[\s\S]*?\.stage-row \{\s*gap: ([\d.]+)px;/.exec(css)[1]);
  // The page is 16 px from each edge and the column is the swatch plus 12 px.
  const card = 390 - 2 * 16 - (swatch + 12) - rowGap;
  // Ten swatches and the Lock with a gap between each, the reach at both ends of the list and 2 px under the Lock.
  const column = 11 * swatch + 10 * gap + 2 * reach + 2;
  assert.ok(column <= card, `${column} px of swatches beside a ${card} px preview`);
  // The picked ring (paper, then 2 px of ink) and the focus ring (3 px of yellow, then 2 px of ink) stay inside the reach.
  assert.ok(ring + 2 <= reach, 'the picked ring fits');
  const focus = Object.fromEntries(declarations(css, 'label.swatch:has(input:focus-visible)'));
  const outline = Number.parseFloat(focus.outline);
  const offset = Number.parseFloat(focus['outline-offset']);
  assert.equal(focus['box-shadow'], '0 0 0 3px var(--accent)');
  assert.ok(offset >= 3, 'the outline sits outside the yellow halo');
  assert.ok(outline + offset <= reach, 'the focus ring fits');
  // The list keeps the reach at its ends and the column keeps 6 px a side.
  assert.equal(Object.fromEntries(declarations(css, '.swatch-list')).padding, 'var(--swatch-reach) 0');
  assert.ok(reach <= 6, 'the column has 6 px a side');
});

test('the other groups are tabs in one panel, and the arrow keys move along them', async () => {
  const js = await read('builder.js');
  const html = await read('index.html');
  assert.match(html, /<div id="tabs" class="tabs" role="tablist" aria-label="Traits"><\/div>/);
  assert.match(js, /buildTabs\(tabGroups\(manifest\), locks, pixelArt\);/);
  assert.match(js, /tab\.setAttribute\('role', 'tab'\);\n\s*tab\.setAttribute\('aria-controls', `panel-\$\{group\.id\}`\);\n\s*tab\.setAttribute\('aria-selected', String\(open\)\);/);
  assert.match(js, /panel\.setAttribute\('role', 'tabpanel'\);\n\s*panel\.setAttribute\('aria-labelledby', tab\.id\);\n\s*panel\.hidden = !open;/);
  // One tab is in the Tab order, the open one.
  assert.match(js, /tab\.tabIndex = open \? 0 : -1;/);
  assert.match(js, /const next = tabAfterKey\(tabs\.indexOf\(document\.activeElement\), event\.key, tabs\.length\);/);
  // The panel names the group's pick.
  assert.match(js, /pick\.textContent = choiceLabel\(group, selection\[group\.id\] \?\? null\);/);
});

test('a click on a tile redraws the preview with a settle, and a lock, the Circle switch or a size do not', async () => {
  const js = await read('builder.js');
  const change = /controlsEl\.addEventListener\('change', \(event\) => \{([\s\S]*?)\n    \}\);/.exec(js)[1];
  assert.match(change, /if \(target === circleEl\)/);
  assert.match(change, /else if \(target\.name === SIZE_NAME\) return;/);
  assert.match(change, /else if \(target\.type === 'checkbox'\) updateButtons\(\);/);
  assert.match(change, /else current\?\.render\(\{ settle: true \}\);/);
  // The render reads the picked tiles and writes the preview.
  assert.match(js, /const selection = readSelection\(manifest\);\n\s*showPicks\(manifest, selection\);/);
  assert.match(js, /selection\[group\.id\] = pageChoice\(group, picked\?\.value\);/);
  assert.match(js, /if \(settle\) replay\(stageCardEl, 'settle'\);/);
  // The form never submits.
  assert.match(js, /controlsEl\.addEventListener\('submit', \(event\) => event\.preventDefault\(\)\);/);
});

test('the preview and the download draw every picked layer, and only the thumbnails leave out the groups drawn over', async () => {
  const js = await read('builder.js');
  assert.match(js, /const rasters = await Promise\.all\(layers\.map\(\(\{ option \}\) => layerCache\.get\(option\.src\)\)\);/);
  assert.match(js, /const picture = compositeLayers\(width, height, rasters\);\n\s*putPicture\(previewEl, picture\);\n\s*setFinished\(picture\);/);
  assert.match(js, /if \(!plan\.scaled\) return previewEl;\n\s*const picture = pictureToSave\(finished, plan\);/);
  // The page never filters layers by over. That is drawThumbnail's job, in the worker.
  assert.doesNotMatch(js, /thumbnailLayers|coversInThumbnails|\.over\b/);
});

test('a group with one choice gets no tiles, no Lock and no thumbnails on the page', async () => {
  const js = await read('builder.js');
  // The column and the tabs come from swatchGroup and tabGroups, which leave such a group out (test/builder-layout.test.js).
  assert.match(js, /buildSwatches\(swatchGroup\(manifest\), locks, pixelArt\);\n\s*buildTabs\(tabGroups\(manifest\), locks, pixelArt\);/);
  assert.match(js, /for \(const group of manifest\.groups\.filter\(hasLock\)\) \{\n\s*locks\[group\.id\] = lockInput\(group\)\.checked;/);
  assert.match(js, /if \(traitTiles\(group\)\.length === 0\) continue;\n\s*const key = thumbnailKey/);
});

test('at 900 px and wider the preview column stays in view, and below that the page scrolls as one', async () => {
  const css = plain(await read('builder.css'));
  const html = await read('index.html');
  const column = /<section class="stage-column" aria-label="Preview">([\s\S]*?)<\/section>/.exec(html);
  assert.ok(column, 'the preview section has the class');
  for (const id of ['swatches', 'preview', 'circle', 'randomize', 'download', 'reset', 'size']) {
    assert.match(column[1], new RegExp(`id="${id}"`), id);
  }
  const wide = /@media \(min-width: 900px\)\s*\{\s*\.stage-column\s*\{([^}]*)\}\s*\}/.exec(css);
  assert.ok(wide, 'the sticky rule sits in a min-width: 900px query');
  assert.match(wide[1], /position: sticky;/);
  // A column taller than the window scrolls on its own, so Download is always in reach.
  assert.match(wide[1], /max-height: calc\(100vh - 16px\);/);
  assert.match(wide[1], /overflow-y: auto;/);
  // The padding, taken back by the margin, is as wide as the stars reach past the card (.sparkles inset -16px).
  assert.match(wide[1], /padding: 16px;\s*margin: -16px;/);
  assert.match(css, /\.sparkles \{[^}]*inset: -16px;/);
  for (const [, offset] of css.matchAll(/\.sparkles span:nth-child\(\d\) \{[^}]*?(?:left|right|top|bottom): (-?\d+)px/g)) {
    assert.ok(Number(offset) >= 0, 'no star reaches past the sparkles box');
  }
  assert.equal(css.match(/position:\s*sticky/g).length, 1);
  assert.equal(Object.fromEntries(declarations(css, '.layout'))['align-items'], 'start');
  // Under 900 px one column.
  assert.match(css, /@media \(max-width: 899px\)\s*\{\s*\.layout\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
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
  assert.match(worker, /if \(request\.ticket < latest\) return null;/);
  assert.match(worker, /self\.postMessage\(\{ type: 'tiles', ticket, groupId, key, tiles \}/);
  assert.match(worker, /createLayerLoader\(manifest, manifestUrl, THUMBNAIL_LAYER_BYTES\)/);
});

test('the page keeps the layers of the picture on screen up to its limit', async () => {
  const js = await read('builder.js');
  assert.match(js, /createLayerLoader\(manifest, baseUrl, PAGE_LAYER_BYTES\)/);
  assert.doesNotMatch(js, /new Map\(\);\n\s*let latest/, 'no cache without a limit');
});

test('Lock sits in the heading row of its group, Randomize keeps the locked groups and Reset puts back the defaults', async () => {
  const js = await read('builder.js');
  assert.match(js, /heading\.className = 'trait-heading';/);
  assert.match(js, /heading\.append\(title, pick, makeLock\(group, locks\[group\.id\], false\)\);/);
  assert.match(js, /swatchesEl\.append\(title, grid, makeLock\(group, locks\[group\.id\], true\)\);/);
  // Randomize keeps the locked groups, then checks the tile of each choice, sparkles and redraws.
  assert.match(
    js,
    /writeSelection\(manifest, randomizeUnlocked\(manifest, readSelection\(manifest\), locks\)\);\n\s*replay\(sparklesEl, 'go'\);\n\s*current\.render\(\{ settle: true \}\);/,
  );
  assert.match(js, /for \(const input of tileInputs\(group\)\) input\.checked = input\.value === value;/);
  // Reset takes its picks and its locks from src/builder-layout.js.
  assert.match(js, /const \{ selection, locks \} = resetState\(manifest\);\n\s*writeSelection\(manifest, selection\);\n\s*writeLocks\(manifest, locks\);/);
  assert.match(js, /resetEl\.disabled = !canReset\(manifest, readSelection\(manifest\), locks\);/);
  assert.match(js, /randomizeEl\.disabled = !canRandomize\(manifest, locks\);/);
});

test('the picked tile shows a check mark and a ring, not only another colour', async () => {
  const css = await read('builder.css');
  const picked = Object.fromEntries(declarations(css, 'label.tile:not(.swatch):has(input:checked)'));
  assert.ok(picked['box-shadow'], 'a ring inside the frame');
  const mark = Object.fromEntries(declarations(css, 'label.tile:not(.swatch):has(input:checked)::after'));
  assert.equal(mark.content, "'✓'");
  assert.equal(mark.position, 'absolute');
  // The mark sits inside the tile, so it never sticks out of the panel.
  assert.ok(Number.parseFloat(mark.top) >= 0 && Number.parseFloat(mark.right) >= 0);
  const focus = Object.fromEntries(declarations(css, 'label.tile:not(.swatch):has(input:focus-visible)'));
  assert.match(focus.outline ?? '', /solid/, 'a focused tile has an outline');
});

test('the tiles fill the panel at each width and four go to a row at 390 px', async () => {
  const css = plain(await read('builder.css'));
  // The first .tiles rule is the one for each width. The phone query comes later and sets four columns.
  const first = (property) => declarations(css, '.tiles').find(([name]) => name === property)?.[1];
  assert.equal(first('display'), 'grid');
  assert.equal(first('grid-template-columns'), 'repeat(auto-fill, minmax(min(var(--thumbnail), 100%), 1fr))');
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.tiles\s*\{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  // Nothing in a trait panel sets a width that could push past the column.
  for (const selector of ['.trait', '.trait-heading', '.tiles', 'label.tile:not(.swatch)']) {
    const rule = Object.fromEntries(declarations(css, selector));
    assert.equal(rule.width, undefined, selector);
    assert.equal(rule['min-width'] ?? '0', '0', selector);
  }
});

test('the settle, the sparkle and the pop stop with reduced motion on', async () => {
  const css = plain(await read('builder.css'));
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(css.trim());
  assert.ok(reduced, 'the reduced-motion query is the last rule');
  assert.match(reduced[1], /\*,\s*\*::before,\s*\*::after\s*\{\s*animation: none !important;\s*transition: none !important;/);
  for (const name of ['settle', 'sparkle', 'pop']) assert.match(css, new RegExp(`@keyframes ${name}\\b`));
  // A star is see-through until it plays, so with no animation it never shows.
  assert.equal(Object.fromEntries(declarations(css, '.sparkles span')).opacity, '0');
  const js = await read('builder.js');
  assert.match(js, /function replay\(element, className\) \{\n\s*element\.classList\.remove\(className\);\n\s*void element\.offsetWidth;\n\s*element\.classList\.add\(className\);/);
});

test('on a phone Reset wraps to its own line before the buttons overlap', async () => {
  const css = plain(await read('builder.css'));
  // One flex row that wraps, at each width. No grid track pins two buttons side by side.
  const actions = Object.fromEntries(declarations(css, '.actions'));
  assert.equal(actions.display, 'flex');
  assert.equal(actions['flex-wrap'], 'wrap');
  assert.equal(declarations(css, '.actions').filter(([name]) => name === 'display').length, 1);
  const phone = /@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(phone, /#randomize\s*\{\s*flex: 1 1 100%;/);
  assert.match(phone, /#download\s*\{\s*flex: 1 1 auto;/);
  // A button is never wider than its row.
  assert.equal(Object.fromEntries(declarations(css, '.button'))['max-width'], '100%');
});

import { validateManifest, resolveSelection } from '../src/manifest.js';
import { choiceValue, createRedrawTracker, pageChoice, thumbnailKey, traitTiles } from '../src/thumbnails.js';
import { PAGE_LAYER_BYTES } from '../src/layer-cache.js';
import { createLayerLoader } from './layers.js';
import {
  canRandomize,
  hasLock,
  lockAccessibleName,
  lockControlName,
  lockText,
  randomizeUnlocked,
  startingLocks,
} from '../src/locks.js';
import { canReset, characterTabOpens, choiceLabel, resetState, swatchGroup, tabAfterKey, tabGroups } from '../src/builder-layout.js';
import { NAME, pageTitle } from '../src/brand.js';
import { compositeLayers } from '../src/composite.js';
import { pictureToSave, planDownload, sizePicker } from '../src/download.js';
import { LOCAL_STYLES_PREFIX, isPixelArt, mayLoadLocalStyles, mergeStyleLists } from '../src/local-styles.js';

import {
  createStyleSwitcher,
  resolveManifestUrl,
  styleFromSearch,
  styleMismatch,
  validateStyleIndex,
} from '../src/styles.js';

const STYLE_INDEX = '../styles/index.json';
/** The local preview server lists style folders kept outside the repository here. */
const LOCAL_STYLE_INDEX = `../${LOCAL_STYLES_PREFIX}/index.json`;
/** The name of the Size radio buttons. A group id has no colon, so no group's tiles share it. */
const SIZE_NAME = 'download:size';
/** The name of the Character tab's radio buttons. It has a colon too, so no group's tiles share it. */
const BASE_NAME = 'style:base';

const statusEl = document.querySelector('#status');
const noticeEl = document.querySelector('#notice');
const basesEl = document.querySelector('#bases');
const characterPickEl = document.querySelector('#character-pick');
const controlsEl = document.querySelector('#controls');
const swatchesEl = document.querySelector('#swatches');
const tabsEl = document.querySelector('#tabs');
const panelsEl = document.querySelector('#panels');
const randomizeEl = document.querySelector('#randomize');
const downloadEl = document.querySelector('#download');
const resetEl = document.querySelector('#reset');
const sizeEl = document.querySelector('#size');
const previewEl = document.querySelector('#preview');
const stageCardEl = document.querySelector('.stage-card');
const sparklesEl = document.querySelector('.sparkles');
const circleEl = document.querySelector('#circle');

/**
 * The style on screen: its manifest and the function that redraws it. It is
 * null while a style is loading and after one failed to load.
 * @type {{ manifest: import('../src/manifest.js').Manifest, render: (motion?: { settle?: boolean }) => Promise<void> } | null}
 */
let current = null;

/**
 * The picture in the preview, as compositeLayers drew it at canvas size. It
 * is null whenever Download is disabled.
 * @type {import('../src/composite.js').Raster | null}
 */
let finished = null;

/**
 * Download and the Size picker are enabled together, while a finished
 * picture is on screen.
 * @param {import('../src/composite.js').Raster | null} picture
 */
function setFinished(picture) {
  finished = picture;
  downloadEl.disabled = picture === null;
  sizeEl.disabled = picture === null;
}

/** Put a picture's pixels on a canvas of the picture's size. */
function putPicture(canvasEl, picture) {
  canvasEl.getContext('2d').putImageData(new ImageData(picture.data, picture.width, picture.height), 0, 0);
}

/** Empty the preview. */
function clearPreview() {
  previewEl.getContext('2d').clearRect(0, 0, previewEl.width, previewEl.height);
}

/**
 * Start a CSS animation again from its first frame: take the class off,
 * make the browser see it gone, and put it back. web/builder.css turns each
 * of these animations off for prefers-reduced-motion.
 */
function replay(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

async function loadJson(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${what} (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${what[0].toUpperCase()}${what.slice(1)} is not valid JSON.`);
  }
}

/** The index is a file of this site, next to the page's folder. */
async function loadStyleIndex(url) {
  const index = await loadJson(url, 'the list of styles');
  const result = validateStyleIndex(index);
  if (!result.ok) throw new Error(`The list of styles is not valid: ${result.errors.join('; ')}`);
  return index;
}

/**
 * The local styles, when the page runs on the local preview server and it
 * was started with a styles folder. Anything else gives null: local styles
 * are an extra, and the page works without them.
 */
async function loadLocalStyleIndex(url) {
  if (!mayLoadLocalStyles(location.hostname)) return null;
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function loadManifest(entry, url) {
  const manifest = await loadJson(url, 'the manifest');
  const result = validateManifest(manifest);
  if (!result.ok) throw new Error(`The manifest is not valid: ${result.errors.join('; ')}`);
  const mismatch = styleMismatch(entry, manifest);
  if (mismatch) throw new Error(`The manifest is for another style: ${mismatch}.`);
  return manifest;
}

/** The radio buttons of a group's tiles, in order. */
function tileInputs(group) {
  return [...controlsEl.querySelectorAll(`input[type="radio"][name="${group.id}"]`)];
}

/** The picked tile of each group, and the one option of a group with no tiles. */
function readSelection(manifest) {
  const selection = {};
  for (const group of manifest.groups) {
    // A group with one choice has no tiles. pageChoice gives its one option.
    const picked = tileInputs(group).find((input) => input.checked);
    selection[group.id] = pageChoice(group, picked?.value);
  }
  return selection;
}

/** Check the tile of each group's choice in `selection`, so the tiles match the preview. */
function writeSelection(manifest, selection) {
  for (const group of manifest.groups) {
    const value = choiceValue(selection[group.id] ?? null);
    for (const input of tileInputs(group)) input.checked = input.value === value;
  }
}

/** The Lock checkbox of a group. */
function lockInput(group) {
  return controlsEl.elements.namedItem(lockControlName(group.id));
}

function readLocks(manifest) {
  const locks = {};
  for (const group of manifest.groups.filter(hasLock)) {
    locks[group.id] = lockInput(group).checked;
  }
  return locks;
}

function writeLocks(manifest, locks) {
  for (const group of manifest.groups.filter(hasLock)) {
    lockInput(group).checked = locks[group.id] === true;
  }
}

/**
 * Randomize is off while no style is on screen and while each group with a
 * Lock is locked. Reset is off while the picks and the locks are the ones
 * the style opens with.
 */
function updateButtons() {
  if (!current) {
    randomizeEl.disabled = true;
    resetEl.disabled = true;
    return;
  }
  const { manifest } = current;
  const locks = readLocks(manifest);
  randomizeEl.disabled = !canRandomize(manifest, locks);
  resetEl.disabled = !canReset(manifest, readSelection(manifest), locks);
}

/**
 * A Lock: a checkbox in a label with a padlock and the word Lock. The
 * aria-label names the group. In the swatch column the word is hidden on
 * screen and stays the label's text for screen readers.
 */
function makeLock(group, locked, compact) {
  const lock = document.createElement('label');
  lock.className = compact ? 'lock compact' : 'lock';
  lock.title = lockAccessibleName(group);
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.name = lockControlName(group.id);
  checkbox.checked = locked;
  checkbox.setAttribute('aria-label', lockAccessibleName(group));
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'icon padlock');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path class="shackle" d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />';
  const text = document.createElement('span');
  text.className = 'lock-text';
  text.textContent = lockText();
  lock.append(checkbox, icon, text);
  return lock;
}

/**
 * One tile: a radio button with the option's label as its name, so a grid
 * of tiles is a radio group. Tab reaches the picked tile and the arrow keys
 * move the pick. The canvas holds the thumbnail and is hidden from screen
 * readers.
 */
function makeTile(group, tile, picked, className, pixelArt) {
  const label = document.createElement('label');
  label.className = className;
  label.title = tile.label;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = group.id;
  input.value = tile.value;
  input.checked = picked;
  const thumb = document.createElement('canvas');
  thumb.className = pixelArt ? 'thumb pixel-art' : 'thumb';
  thumb.width = 1;
  thumb.height = 1;
  thumb.dataset.group = group.id;
  thumb.dataset.value = tile.value;
  thumb.setAttribute('aria-hidden', 'true');
  // The option's label is the radio button's accessible name. It is hidden on screen.
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = tile.label;
  label.append(input, thumb, name);
  return label;
}

/** A grid of a group's tiles, named by the element with `labelId`. The first tile starts picked. */
function makeGrid(group, className, tileClass, labelId, pixelArt) {
  const grid = document.createElement('div');
  grid.className = className;
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-labelledby', labelId);
  traitTiles(group).forEach((tile, index) => grid.append(makeTile(group, tile, index === 0, tileClass, pixelArt)));
  return grid;
}

/**
 * The swatch column: the background group's options as round swatches, its
 * name for screen readers and its Lock at the foot of the column.
 */
function buildSwatches(group, locks, pixelArt) {
  if (!group) {
    swatchesEl.hidden = true;
    return;
  }
  const title = document.createElement('h2');
  title.id = `trait-${group.id}`;
  title.className = 'visually-hidden';
  title.textContent = group.label;
  const grid = makeGrid(group, 'swatch-list', 'tile swatch', title.id, pixelArt);
  swatchesEl.append(title, grid, makeLock(group, locks[group.id], true));
  swatchesEl.hidden = false;
}

/**
 * The trait panel: after the Character tab, one tab per group, and under
 * the tabs that group's panel. A panel's heading holds the group's name,
 * the name of its pick and its Lock, then its grid of tiles. The trait tabs
 * and panels carry data-trait, so a new style replaces them and leaves the
 * Character tab as it is.
 */
function buildTabs(groups, locks, pixelArt) {
  for (const group of groups) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `tab-${group.id}`;
    tab.className = 'tab';
    tab.dataset.trait = '';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${group.id}`);
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    tab.textContent = group.label;
    tabsEl.append(tab);

    const panel = document.createElement('div');
    panel.id = `panel-${group.id}`;
    panel.className = 'trait';
    panel.dataset.trait = '';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;

    const heading = document.createElement('div');
    heading.className = 'trait-heading';
    const title = document.createElement('h2');
    title.id = `trait-${group.id}`;
    title.textContent = group.label;
    const pick = document.createElement('p');
    pick.className = 'pick';
    pick.dataset.group = group.id;
    heading.append(title, pick, makeLock(group, locks[group.id], false));

    panel.append(heading, makeGrid(group, 'tiles', 'tile', title.id, pixelArt));
    panelsEl.append(panel);
  }
}

function buildControls(manifest) {
  clearControls();
  const locks = startingLocks(manifest);
  const pixelArt = isPixelArt(manifest.canvas.width);
  buildSwatches(swatchGroup(manifest), locks, pixelArt);
  buildTabs(tabGroups(manifest), locks, pixelArt);
}

/** Take the last style's swatches and trait tabs off the page. The Character tab stays. */
function clearControls() {
  swatchesEl.replaceChildren();
  for (const element of [...tabsEl.children, ...panelsEl.children]) {
    if (element.hasAttribute('data-trait')) element.remove();
  }
}

/** Open the tab at `index` and close the others. */
function openTab(index, focus) {
  const tabs = [...tabsEl.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, at) => {
    const open = at === index;
    tab.setAttribute('aria-selected', String(open));
    tab.tabIndex = open ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !open;
  });
  if (focus) tabs[index]?.focus();
}

/** Write the name of each group's pick next to the group's name. */
function showPicks(manifest, selection) {
  for (const pick of panelsEl.querySelectorAll('p.pick[data-group]')) {
    const group = manifest.groups.find((item) => item.id === pick.dataset.group);
    pick.textContent = choiceLabel(group, selection[group.id] ?? null);
  }
}

/** The thumbnail canvas of one tile. */
function thumbCanvas(groupId, value) {
  return [...controlsEl.querySelectorAll('canvas.thumb')].find(
    (canvasEl) => canvasEl.dataset.group === groupId && canvasEl.dataset.value === value,
  );
}

/**
 * Thumbnails are drawn in web/thumbnail-worker.js, so compositing a big
 * canvas for each tile doesn't hold up the page. One worker serves each
 * style. `thumbnailTicket` goes up with each request, across styles, and an
 * answer for an older ticket is dropped.
 */
let thumbnailWorker = null;
let thumbnailTicket = 0;
/** The renderer on screen takes the worker's answers. */
let receiveThumbnails = null;

function startThumbnailWorker() {
  if (thumbnailWorker) return thumbnailWorker;
  thumbnailWorker = new Worker(new URL('thumbnail-worker.js', import.meta.url), { type: 'module' });
  thumbnailWorker.addEventListener('message', (event) => {
    if (event.data.type === 'base') paintBaseTile(event.data);
    // A tile whose picture failed stays blank. Opening the style reports the problem in the status line.
    else if (event.data.type !== 'base-error') receiveThumbnails?.(event.data);
  });
  thumbnailWorker.addEventListener('error', (event) => {
    event.preventDefault();
    receiveThumbnails?.({ type: 'error', ticket: thumbnailTicket, message: event.message || 'The thumbnail worker stopped.' });
  });
  return thumbnailWorker;
}

function createRenderer(manifest, baseUrl, isOnScreen) {
  // The layers of the picture on screen, up to PAGE_LAYER_BYTES. A failed load is dropped, so the next render tries again.
  const layerCache = createLayerLoader(manifest, baseUrl, PAGE_LAYER_BYTES);
  let latest = 0;

  /** The thumbnailKey each group's tiles show. */
  const redraws = createRedrawTracker();

  /** Ask the worker for each group whose tiles show another picture now. */
  function requestThumbnails(selection) {
    const ticket = (thumbnailTicket += 1);
    const worker = startThumbnailWorker();
    for (const group of manifest.groups) {
      if (traitTiles(group).length === 0) continue;
      const key = thumbnailKey(manifest, selection, group.id);
      if (!redraws.needsRedraw(group.id, key)) continue;
      worker.postMessage({ ticket, manifest, manifestUrl: String(baseUrl), selection, groupId: group.id, key });
    }
  }

  /** Paint a group's tiles from the worker's answer, all of them at once. */
  receiveThumbnails = (answer) => {
    if (answer.ticket !== thumbnailTicket || !isOnScreen()) return;
    if (answer.type === 'error') {
      setStatus(`Could not draw the thumbnails. ${answer.message}`, true);
      return;
    }
    // The key goes before the first tile changes, so a paint that fails halfway is redrawn next time.
    redraws.start(answer.groupId);
    for (const tile of answer.tiles) {
      const canvasEl = thumbCanvas(answer.groupId, tile.value);
      if (!canvasEl) continue;
      canvasEl.width = tile.width;
      canvasEl.height = tile.height;
      putPicture(canvasEl, tile);
    }
    redraws.finish(answer.groupId, answer.key);
  };

  /**
   * Draw the picked layers into the preview. `settle` plays the short scale
   * that shows the picture changed, after a pick, Randomize or Reset.
   */
  return async function render({ settle = false } = {}) {
    const ticket = (latest += 1);
    setFinished(null);
    try {
      const selection = readSelection(manifest);
      showPicks(manifest, selection);
      updateButtons();
      const layers = resolveSelection(manifest, selection);
      const rasters = await Promise.all(layers.map(({ option }) => layerCache.get(option.src)));
      // A newer selection or another style started while these layers were loading.
      if (ticket !== latest || !isOnScreen()) return;
      const { width, height } = manifest.canvas;
      const picture = compositeLayers(width, height, rasters);
      putPicture(previewEl, picture);
      setFinished(picture);
      if (settle) replay(stageCardEl, 'settle');
      setStatus('');
      try {
        requestThumbnails(selection);
      } catch (error) {
        // A browser without module workers keeps the preview and shows blank tiles.
        setStatus(`Could not draw the thumbnails. ${reason(error)}`, true);
      }
    } catch (error) {
      if (ticket !== latest || !isOnScreen()) return;
      setStatus(reason(error), true);
    }
  };
}

/** The picked size, or an empty string when the style offers one size and the picker is hidden. */
function pickedSize() {
  const picked = sizeEl.querySelector(`input[name="${SIZE_NAME}"]:checked`);
  return picked ? picked.value : '';
}

/**
 * List the sizes this style offers as radio buttons. The pick is kept when
 * the style offers it. A style with one size gets no picker.
 */
function buildSizePicker(manifest) {
  const { options, value, shown } = sizePicker(manifest.canvas, pickedSize());
  const legend = sizeEl.querySelector('legend');
  sizeEl.replaceChildren(
    legend,
    ...options.map(({ id, label }) => {
      const choice = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = SIZE_NAME;
      input.value = id;
      input.checked = id === value;
      const text = document.createElement('span');
      text.textContent = label;
      choice.append(input, text);
      return choice;
    }),
  );
  sizeEl.hidden = !shown;
}

/**
 * The canvas whose pixels are saved. Full size is the preview canvas as it
 * is. A smaller size is the finished picture scaled down, on a canvas of
 * its own. No layer is drawn here.
 */
function canvasToSave(plan) {
  if (!plan.scaled) return previewEl;
  const picture = pictureToSave(finished, plan);
  const canvas = document.createElement('canvas');
  canvas.width = picture.width;
  canvas.height = picture.height;
  putPicture(canvas, picture);
  return canvas;
}

function download(manifest) {
  if (!finished) return;
  const failed = () => setStatus('Could not make the PNG file.', true);
  const plan = planDownload(manifest, pickedSize());
  try {
    canvasToSave(plan).toBlob((blob) => {
      if (!blob) {
        failed();
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = plan.fileName;
      link.click();
      // Give the browser time to start the download before the URL is released.
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'image/png');
  } catch {
    failed();
  }
}

/** Empty the page of the last style, so a failed switch never shows a mix of two styles. */
function clearStyle() {
  current = null;
  updateButtons();
  setFinished(null);
  clearControls();
  clearPreview();
}

/** The radio button of a style in the Character tab. */
function baseInput(id) {
  return [...basesEl.querySelectorAll(`input[name="${BASE_NAME}"]`)].find((input) => input.value === id);
}

/**
 * The Character tab's tiles: one per style in the style index, in its
 * order, styled like the trait tiles. Each tile is a radio button named by
 * the style's name, so the grid is a radio group like the trait grids. A new
 * style in the index is a new tile.
 */
function buildBaseRow(styles) {
  basesEl.replaceChildren(
    ...styles.map((entry) => {
      const label = document.createElement('label');
      label.className = 'tile base';
      label.title = entry.name;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = BASE_NAME;
      input.value = entry.id;
      const thumb = document.createElement('canvas');
      thumb.className = 'thumb base-thumb';
      thumb.width = 1;
      thumb.height = 1;
      thumb.setAttribute('aria-hidden', 'true');
      // The style's name is the radio button's accessible name. It is hidden on screen, like a trait tile's.
      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = entry.name;
      label.append(input, thumb, name);
      return label;
    }),
  );
}

/**
 * Ask the thumbnail worker for the picture each style opens with, for its
 * tile, after the first style is on screen. The worker draws them one after
 * the other off the main thread, and reuses the layers of the style on
 * screen. A style whose manifest doesn't load keeps a blank tile: picking it
 * shows why.
 */
async function drawBaseTiles(styles) {
  let worker;
  try {
    worker = startThumbnailWorker();
  } catch {
    // A browser without module workers shows blank tiles. The row still works.
    return;
  }
  for (const entry of styles) {
    try {
      const url = resolveManifestUrl(entry, entry.indexUrl);
      const manifest = await loadManifest(entry, url);
      // Small fixture pictures are scaled up on the tile, so keep their pixels sharp.
      baseInput(entry.id)?.parentElement.querySelector('canvas.base-thumb').classList.toggle('pixel-art', isPixelArt(manifest.canvas.width));
      worker.postMessage({ kind: 'base', id: entry.id, manifest, manifestUrl: String(url) });
    } catch {
      // The tile stays blank. Opening the style reports the problem in the status line.
    }
  }
}

/** Put the worker's picture on a style's tile in the Character tab. */
function paintBaseTile({ id, width, height, data }) {
  const canvasEl = baseInput(id)?.parentElement.querySelector('canvas.base-thumb');
  if (!canvasEl) return;
  canvasEl.width = width;
  canvasEl.height = height;
  putPicture(canvasEl, { width, height, data });
}

function showStyleInAddress(id) {
  const url = new URL(location.href);
  url.searchParams.set('style', id);
  history.replaceState(null, '', url);
}

/**
 * Puts one style on screen at a time. The Character tab stays usable the
 * whole time, so a style that fails to load can be swapped for another one.
 * createStyleSwitcher drops a style that finishes loading after a newer pick.
 */
function createSwitcher() {
  /** Whether a style was on screen before this one. */
  let shownBefore = false;
  return createStyleSwitcher({
    clear(entry) {
      clearStyle();
      const input = baseInput(entry.id);
      if (input) input.checked = true;
      characterPickEl.textContent = entry.name;
      showStyleInAddress(entry.id);
      setStatus(`Loading ${entry.name}...`);
    },
    async load(entry) {
      const url = resolveManifestUrl(entry, entry.indexUrl);
      return { url, manifest: await loadManifest(entry, url) };
    },
    async show(entry, { url, manifest }, isOnScreen) {
      previewEl.width = manifest.canvas.width;
      previewEl.height = manifest.canvas.height;
      previewEl.classList.toggle('pixel-art', isPixelArt(manifest.canvas.width));
      buildControls(manifest);
      // The Character tab is the first tab. Which tab opens is characterTabOpens in src/builder-layout.js.
      const characterOpens = characterTabOpens({ styleCount: basesEl.children.length, firstStyle: !shownBefore });
      openTab(characterOpens || tabsEl.children.length === 1 ? 0 : 1, false);
      shownBefore = true;
      buildSizePicker(manifest);
      const render = createRenderer(manifest, url, isOnScreen);
      current = { manifest, render };
      await render();
    },
    fail(entry, error) {
      clearStyle();
      setStatus(`Could not open ${entry.name}. ${reason(error)}`, true);
    },
  });
}

/** The name in the wordmark and the title comes from src/brand.js, the one place it is written. */
function showName() {
  document.querySelector('#wordmark').textContent = NAME;
  document.title = pageTitle(NAME);
}

async function start() {
  showName();
  try {
    const indexUrl = new URL(STYLE_INDEX, location.href);
    const localIndexUrl = new URL(LOCAL_STYLE_INDEX, location.href);
    const [repoIndex, localIndex] = await Promise.all([loadStyleIndex(indexUrl), loadLocalStyleIndex(localIndexUrl)]);
    const index = { styles: mergeStyleLists(repoIndex, indexUrl, localIndex, localIndexUrl) };
    buildBaseRow(index.styles);
    const switcher = createSwitcher();
    basesEl.addEventListener('change', (event) => {
      const { target } = event;
      if (!(target instanceof HTMLInputElement) || target.name !== BASE_NAME) return;
      noticeEl.textContent = '';
      const entry = index.styles.find((candidate) => candidate.id === target.value);
      if (entry) switcher.open(entry);
    });
    controlsEl.addEventListener('submit', (event) => event.preventDefault());
    controlsEl.addEventListener('change', (event) => {
      const { target } = event;
      if (!(target instanceof HTMLInputElement)) return;
      // The Circle switch shows the preview cut to a circle. The picture stays as it is.
      if (target === circleEl) stageCardEl.classList.toggle('round', circleEl.checked);
      // A size changes what Download saves next, and a character tile opens another style (see basesEl). Neither redraws here.
      else if (target.name === SIZE_NAME || target.name === BASE_NAME) return;
      // A lock changes what Randomize does next. The picture stays as it is.
      else if (target.type === 'checkbox') updateButtons();
      // A tile's radio button changes the picture.
      else current?.render({ settle: true });
    });
    tabsEl.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab) openTab([...tabsEl.children].indexOf(tab), false);
    });
    tabsEl.addEventListener('keydown', (event) => {
      const tabs = [...tabsEl.children];
      const next = tabAfterKey(tabs.indexOf(document.activeElement), event.key, tabs.length);
      if (next === null) return;
      event.preventDefault();
      openTab(next, true);
    });
    randomizeEl.addEventListener('click', () => {
      if (!current) return;
      const { manifest } = current;
      const locks = readLocks(manifest);
      if (!canRandomize(manifest, locks)) return;
      writeSelection(manifest, randomizeUnlocked(manifest, readSelection(manifest), locks));
      replay(sparklesEl, 'go');
      current.render({ settle: true });
    });
    resetEl.addEventListener('click', () => {
      if (!current) return;
      const { manifest } = current;
      const { selection, locks } = resetState(manifest);
      writeSelection(manifest, selection);
      writeLocks(manifest, locks);
      current.render({ settle: true });
    });
    downloadEl.addEventListener('click', () => {
      if (current) download(current.manifest);
    });
    const { entry, notice } = styleFromSearch(index, location.search);
    noticeEl.textContent = notice;
    await switcher.open(entry);
    await drawBaseTiles(index.styles);
  } catch (error) {
    setStatus(reason(error), true);
  }
}

start();

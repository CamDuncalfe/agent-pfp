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
import { compositeLayers } from '../src/composite.js';
import { pictureToSave, planDownload, sizePicker } from '../src/download.js';
import { roundPreviewPicture, roundPreviewSide } from '../src/round-preview.js';
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

const statusEl = document.querySelector('#status');
const noticeEl = document.querySelector('#notice');
const styleEl = document.querySelector('#style');
const controlsEl = document.querySelector('#controls');
const selectionEl = document.querySelector('#selection');
const randomizeEl = document.querySelector('#randomize');
const downloadEl = document.querySelector('#download');
const sizeEl = document.querySelector('#size');
const previewEl = document.querySelector('#preview');
const roundPreviewEl = document.querySelector('#round-preview');

/**
 * The style on screen: its manifest and the function that redraws it. It is
 * null while a style is loading and after one failed to load.
 * @type {{ manifest: import('../src/manifest.js').Manifest, render: () => Promise<void> } | null}
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

/**
 * Show a finished picture in both previews. The round one gets the middle
 * square of the same picture, scaled down when it is big. No layer is drawn
 * for it.
 * @param {import('../src/composite.js').Raster} picture
 */
function showPicture(picture) {
  putPicture(previewEl, picture);
  putPicture(roundPreviewEl, roundPreviewPicture(picture));
}

/** Empty both previews. */
function clearPreviews() {
  for (const canvasEl of [previewEl, roundPreviewEl]) {
    canvasEl.getContext('2d').clearRect(0, 0, canvasEl.width, canvasEl.height);
  }
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

/** Check the tile of each group's choice in `selection`, so the grids match the preview. */
function writeSelection(manifest, selection) {
  for (const group of manifest.groups) {
    const value = choiceValue(selection[group.id] ?? null);
    for (const input of tileInputs(group)) input.checked = input.value === value;
  }
}

function readLocks(manifest) {
  const locks = {};
  for (const group of manifest.groups.filter(hasLock)) {
    locks[group.id] = controlsEl.elements.namedItem(lockControlName(group.id)).checked;
  }
  return locks;
}

/** Randomize is off while no style is on screen and while each group with a Lock is locked. */
function updateRandomize() {
  randomizeEl.disabled = !current || !canRandomize(current.manifest, readLocks(current.manifest));
}

/**
 * One section per group: a heading row with the group's name and its Lock,
 * then a grid of tiles. Each tile is a radio button with the option's
 * label as its name, so the grid is a radio group: Tab reaches the picked
 * tile and the arrow keys move the pick. The first tile starts picked.
 * A group with one choice gets no section: no tiles and no Lock. Its layer
 * is still drawn and listed.
 */
function buildControls(manifest) {
  controlsEl.replaceChildren();
  const locks = startingLocks(manifest);
  const pixelArt = isPixelArt(manifest.canvas.width);
  for (const group of manifest.groups) {
    if (!hasLock(group)) continue;
    const row = document.createElement('div');
    row.className = 'trait';

    const heading = document.createElement('div');
    heading.className = 'trait-heading';
    const title = document.createElement('h2');
    title.id = `trait-${group.id}`;
    title.textContent = group.label;

    const lock = document.createElement('label');
    lock.className = 'lock';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = lockControlName(group.id);
    checkbox.checked = locks[group.id];
    // The visible text is the same in each row. The aria-label names the group.
    checkbox.setAttribute('aria-label', lockAccessibleName(group));
    lock.append(checkbox, lockText());
    heading.append(title, lock);

    const grid = document.createElement('div');
    grid.className = 'tiles';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-labelledby', title.id);
    traitTiles(group).forEach((tile, index) => {
      const label = document.createElement('label');
      label.className = 'tile';
      label.title = tile.label;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = group.id;
      input.value = tile.value;
      input.checked = index === 0;
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
      grid.append(label);
    });

    row.append(heading, grid);
    controlsEl.append(row);
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
  thumbnailWorker.addEventListener('message', (event) => receiveThumbnails?.(event.data));
  thumbnailWorker.addEventListener('error', (event) => {
    event.preventDefault();
    receiveThumbnails?.({ type: 'error', ticket: thumbnailTicket, message: event.message || 'The thumbnail worker stopped.' });
  });
  return thumbnailWorker;
}

function showSelection(layers) {
  selectionEl.replaceChildren(
    ...layers.map(({ group, option }) => {
      const item = document.createElement('li');
      item.textContent = `${group.label}: ${option.label}`;
      item.title = option.src;
      return item;
    }),
  );
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

  return async function render() {
    const ticket = (latest += 1);
    setFinished(null);
    try {
      const selection = readSelection(manifest);
      const layers = resolveSelection(manifest, selection);
      showSelection(layers);
      const rasters = await Promise.all(layers.map(({ option }) => layerCache.get(option.src)));
      // A newer selection or another style started while these layers were loading.
      if (ticket !== latest || !isOnScreen()) return;
      const { width, height } = manifest.canvas;
      const picture = compositeLayers(width, height, rasters);
      showPicture(picture);
      setFinished(picture);
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

/** List the sizes this style offers. The pick is kept when the style offers it. */
function buildSizePicker(manifest) {
  const { options, value } = sizePicker(manifest.canvas, sizeEl.value);
  sizeEl.replaceChildren(
    ...options.map(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      return option;
    }),
  );
  sizeEl.value = value;
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
  const plan = planDownload(manifest, sizeEl.value);
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
  randomizeEl.disabled = true;
  setFinished(null);
  controlsEl.replaceChildren();
  selectionEl.replaceChildren();
  clearPreviews();
}

function showStyleInAddress(id) {
  const url = new URL(location.href);
  url.searchParams.set('style', id);
  history.replaceState(null, '', url);
}

/**
 * Puts one style on screen at a time. The Style picker stays usable the
 * whole time, so a style that fails to load can be swapped for another one.
 * createStyleSwitcher drops a style that finishes loading after a newer pick.
 */
function createSwitcher() {
  return createStyleSwitcher({
    clear(entry) {
      clearStyle();
      styleEl.value = entry.id;
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
      // The round canvas is the size of the picture roundPreviewPicture gives. CSS sets its size on screen.
      const side = roundPreviewSide(manifest.canvas);
      roundPreviewEl.width = side;
      roundPreviewEl.height = side;
      buildControls(manifest);
      buildSizePicker(manifest);
      const render = createRenderer(manifest, url, isOnScreen);
      current = { manifest, render };
      updateRandomize();
      await render();
    },
    fail(entry, error) {
      clearStyle();
      setStatus(`Could not open ${entry.name}. ${reason(error)}`, true);
    },
  });
}

async function start() {
  try {
    const indexUrl = new URL(STYLE_INDEX, location.href);
    const localIndexUrl = new URL(LOCAL_STYLE_INDEX, location.href);
    const [repoIndex, localIndex] = await Promise.all([loadStyleIndex(indexUrl), loadLocalStyleIndex(localIndexUrl)]);
    const index = { styles: mergeStyleLists(repoIndex, indexUrl, localIndex, localIndexUrl) };
    for (const entry of index.styles) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name;
      styleEl.append(option);
    }
    const switcher = createSwitcher();
    styleEl.addEventListener('change', () => {
      noticeEl.textContent = '';
      const entry = index.styles.find((candidate) => candidate.id === styleEl.value);
      if (entry) switcher.open(entry);
    });
    controlsEl.addEventListener('change', (event) => {
      // A lock changes what Randomize does next. The picture stays as it is.
      // A tile's radio button changes the picture.
      if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') updateRandomize();
      else current?.render();
    });
    randomizeEl.addEventListener('click', () => {
      if (!current) return;
      const { manifest } = current;
      const locks = readLocks(manifest);
      if (!canRandomize(manifest, locks)) return;
      writeSelection(manifest, randomizeUnlocked(manifest, readSelection(manifest), locks));
      current.render();
    });
    downloadEl.addEventListener('click', () => {
      if (current) download(current.manifest);
    });
    styleEl.disabled = false;

    const { entry, notice } = styleFromSearch(index, location.search);
    noticeEl.textContent = notice;
    await switcher.open(entry);
  } catch (error) {
    setStatus(reason(error), true);
  }
}

start();

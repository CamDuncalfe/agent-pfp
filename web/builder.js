import {
  validateManifest,
  groupChoices,
  resolveSelection,
  resolveLayerUrl,
} from '../src/manifest.js';
import {
  canRandomize,
  lockAccessibleName,
  lockControlName,
  lockText,
  randomizeUnlocked,
  startingLocks,
} from '../src/locks.js';
import { compositeLayers } from '../src/composite.js';
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
const NONE = '';

const statusEl = document.querySelector('#status');
const noticeEl = document.querySelector('#notice');
const styleEl = document.querySelector('#style');
const controlsEl = document.querySelector('#controls');
const selectionEl = document.querySelector('#selection');
const randomizeEl = document.querySelector('#randomize');
const downloadEl = document.querySelector('#download');
const previewEl = document.querySelector('#preview');

/**
 * The style on screen: its manifest and the function that redraws it. It is
 * null while a style is loading and after one failed to load.
 * @type {{ manifest: import('../src/manifest.js').Manifest, render: () => Promise<void> } | null}
 */
let current = null;

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

function readSelection(manifest) {
  const selection = {};
  for (const group of manifest.groups) {
    const value = controlsEl.elements.namedItem(group.id).value;
    selection[group.id] = value === NONE ? null : value;
  }
  return selection;
}

function writeSelection(manifest, selection) {
  for (const group of manifest.groups) {
    controlsEl.elements.namedItem(group.id).value = selection[group.id] ?? NONE;
  }
}

function readLocks(manifest) {
  const locks = {};
  for (const group of manifest.groups) {
    locks[group.id] = controlsEl.elements.namedItem(lockControlName(group.id)).checked;
  }
  return locks;
}

/** Randomize is off while no style is on screen and while each group is locked. */
function updateRandomize() {
  randomizeEl.disabled = !current || !canRandomize(current.manifest, readLocks(current.manifest));
}

function buildControls(manifest) {
  controlsEl.replaceChildren();
  const locks = startingLocks(manifest);
  for (const group of manifest.groups) {
    const row = document.createElement('div');
    row.className = 'trait';
    const label = document.createElement('label');
    label.append(group.label);
    const select = document.createElement('select');
    select.name = group.id;
    for (const choice of groupChoices(group)) {
      const option = document.createElement('option');
      option.value = choice ?? NONE;
      option.textContent = choice === null ? 'None' : group.options.find((item) => item.id === choice).label;
      select.append(option);
    }
    label.append(select);

    const lock = document.createElement('label');
    lock.className = 'lock';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = lockControlName(group.id);
    checkbox.checked = locks[group.id];
    // The visible text is the same in each row. The aria-label names the group.
    checkbox.setAttribute('aria-label', lockAccessibleName(group));
    lock.append(checkbox, lockText());

    row.append(label, lock);
    controlsEl.append(row);
  }
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

/**
 * Load one layer image and read its pixels at the manifest's canvas size.
 * A layer of another size is refused, the same way the render check refuses it.
 *
 * The pixels come back through a 2D canvas, which stores premultiplied
 * alpha. Alpha values and opaque pixels come back exact. The colour of a
 * see-through pixel can shift by a few levels (see docs/render-check.md).
 */
async function loadLayerPixels(url, canvas) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url.pathname} (HTTP ${response.status}).`);
  // Ignore embedded colour profiles, like the PNG reader the render check uses.
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  try {
    if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) {
      throw new Error(
        `${url.pathname} is ${bitmap.width}x${bitmap.height}, the canvas is ${canvas.width}x${canvas.height}.`,
      );
    }
    const scratch = new OffscreenCanvas(canvas.width, canvas.height);
    const context = scratch.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

function createRenderer(manifest, baseUrl, isOnScreen) {
  /** @type {Map<string, Promise<ImageData>>} */
  const cache = new Map();
  let latest = 0;

  function pixelsFor(src) {
    if (!cache.has(src)) {
      const pending = loadLayerPixels(resolveLayerUrl(src, baseUrl), manifest.canvas);
      // A failed load is dropped from the cache, so the next render tries again.
      pending.catch(() => cache.delete(src));
      cache.set(src, pending);
    }
    return cache.get(src);
  }

  return async function render() {
    const ticket = (latest += 1);
    downloadEl.disabled = true;
    try {
      const layers = resolveSelection(manifest, readSelection(manifest));
      showSelection(layers);
      const rasters = await Promise.all(layers.map(({ option }) => pixelsFor(option.src)));
      // A newer selection or another style started while these layers were loading.
      if (ticket !== latest || !isOnScreen()) return;
      const { width, height } = manifest.canvas;
      const picture = compositeLayers(width, height, rasters);
      previewEl.getContext('2d').putImageData(new ImageData(picture.data, width, height), 0, 0);
      downloadEl.disabled = false;
      setStatus('');
    } catch (error) {
      if (ticket !== latest || !isOnScreen()) return;
      setStatus(reason(error), true);
    }
  };
}

function download(manifest) {
  previewEl.toBlob((blob) => {
    if (!blob) {
      setStatus('Could not make the PNG file.', true);
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `agent-pfp-${manifest.style}.png`;
    link.click();
    // Give the browser time to start the download before the URL is released.
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
}

/** Empty the page of the last style, so a failed switch never shows a mix of two styles. */
function clearStyle() {
  current = null;
  randomizeEl.disabled = true;
  downloadEl.disabled = true;
  controlsEl.replaceChildren();
  selectionEl.replaceChildren();
  previewEl.getContext('2d').clearRect(0, 0, previewEl.width, previewEl.height);
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
      buildControls(manifest);
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
      if (event.target instanceof HTMLInputElement) updateRandomize();
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

import {
  validateManifest,
  groupChoices,
  resolveSelection,
  randomSelection,
  resolveLayerUrl,
} from '../src/manifest.js';
import { compositeLayers } from '../src/composite.js';

import { chooseStyle, resolveManifestUrl, styleMismatch, validateStyleIndex } from '../src/styles.js';

const STYLE_INDEX = '../styles/index.json';
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

/** Counts style switches, so a style that finishes loading late is dropped. */
let latestSwitch = 0;

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

function buildControls(manifest) {
  controlsEl.replaceChildren();
  for (const group of manifest.groups) {
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
    controlsEl.append(label);
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
 * Put one style on screen. The Style picker stays usable the whole time, so
 * a style that fails to load can be swapped for another one.
 */
async function openStyle(entry, indexUrl) {
  const ticket = (latestSwitch += 1);
  const isOnScreen = () => ticket === latestSwitch;
  clearStyle();
  styleEl.value = entry.id;
  showStyleInAddress(entry.id);
  setStatus(`Loading ${entry.name}...`);
  try {
    const url = resolveManifestUrl(entry, indexUrl);
    const manifest = await loadManifest(entry, url);
    // Another style was picked while this one was loading.
    if (!isOnScreen()) return;
    previewEl.width = manifest.canvas.width;
    previewEl.height = manifest.canvas.height;
    buildControls(manifest);
    const render = createRenderer(manifest, url, isOnScreen);
    current = { manifest, render };
    randomizeEl.disabled = false;
    await render();
  } catch (error) {
    if (!isOnScreen()) return;
    clearStyle();
    setStatus(`Could not open ${entry.name}. ${reason(error)}`, true);
  }
}

async function start() {
  try {
    const indexUrl = new URL(STYLE_INDEX, location.href);
    const index = await loadStyleIndex(indexUrl);
    for (const entry of index.styles) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name;
      styleEl.append(option);
    }
    styleEl.addEventListener('change', () => {
      noticeEl.textContent = '';
      const entry = index.styles.find((candidate) => candidate.id === styleEl.value);
      if (entry) openStyle(entry, indexUrl);
    });
    controlsEl.addEventListener('change', () => current?.render());
    randomizeEl.addEventListener('click', () => {
      if (!current) return;
      writeSelection(current.manifest, randomSelection(current.manifest));
      current.render();
    });
    downloadEl.addEventListener('click', () => {
      if (current) download(current.manifest);
    });
    styleEl.disabled = false;

    const requested = new URLSearchParams(location.search).get('style');
    const { entry, unknown } = chooseStyle(index, requested);
    if (unknown !== null) {
      noticeEl.textContent = `This builder doesn't know a style called "${unknown}". Showing ${entry.name}.`;
    }
    await openStyle(entry, indexUrl);
  } catch (error) {
    setStatus(reason(error), true);
  }
}

start();

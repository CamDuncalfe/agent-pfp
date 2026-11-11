import {
  validateManifest,
  groupChoices,
  resolveSelection,
  randomSelection,
  resolveLayerUrl,
} from '../src/manifest.js';
import { compositeLayers } from '../src/composite.js';

const DEFAULT_MANIFEST = '../fixtures/shapes/manifest.json';
const NONE = '';

const statusEl = document.querySelector('#status');
const styleNameEl = document.querySelector('#style-name');
const controlsEl = document.querySelector('#controls');
const selectionEl = document.querySelector('#selection');
const randomizeEl = document.querySelector('#randomize');
const downloadEl = document.querySelector('#download');
const previewEl = document.querySelector('#preview');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

/** The manifest has to come from this site, so a link cannot point the page at another host. */
function manifestUrl() {
  const requested = new URLSearchParams(location.search).get('manifest') ?? DEFAULT_MANIFEST;
  const url = new URL(requested, location.href);
  if (url.origin !== location.origin) throw new Error('The manifest has to be on this site.');
  return url;
}

async function loadManifest(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the manifest (HTTP ${response.status}).`);
  const manifest = await response.json();
  const result = validateManifest(manifest);
  if (!result.ok) throw new Error(`The manifest is not valid: ${result.errors.join('; ')}`);
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

function createRenderer(manifest, baseUrl) {
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
      // A newer selection started while these layers were loading.
      if (ticket !== latest) return;
      const { width, height } = manifest.canvas;
      const picture = compositeLayers(width, height, rasters);
      previewEl.getContext('2d').putImageData(new ImageData(picture.data, width, height), 0, 0);
      downloadEl.disabled = false;
      setStatus('');
    } catch (error) {
      if (ticket !== latest) return;
      setStatus(error instanceof Error ? error.message : String(error), true);
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

async function start() {
  try {
    const url = manifestUrl();
    const manifest = await loadManifest(url);
    styleNameEl.textContent = manifest.name;
    previewEl.width = manifest.canvas.width;
    previewEl.height = manifest.canvas.height;
    buildControls(manifest);
    const render = createRenderer(manifest, url);
    controlsEl.addEventListener('change', render);
    randomizeEl.addEventListener('click', () => {
      writeSelection(manifest, randomSelection(manifest));
      render();
    });
    downloadEl.addEventListener('click', () => download(manifest));
    randomizeEl.disabled = false;
    await render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

start();

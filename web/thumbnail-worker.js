/**
 * Draws thumbnails off the page's main thread. The page sends one request
 * per group that needs new thumbnails, and the worker answers with each of
 * the group's tiles at once, so the page never shows half a group.
 *
 * A request is { ticket, manifest, manifestUrl, selection, groupId, key }.
 * A request with a ticket older than the newest one the worker has seen is
 * dropped, also halfway through a group.
 *
 * The answer is { type: 'tiles', ticket, groupId, key, tiles } with tiles
 * as { value, width, height, data }, or { type: 'error', ticket, message }.
 *
 * The page also asks for the picture on each style's tile in the character
 * row: { kind: 'base', id, manifest, manifestUrl }. The worker draws it with
 * basePicture and answers { type: 'base', id, width, height, data }, or
 * { type: 'base-error', id, message }. These requests have no ticket and are
 * never dropped. The style on screen reuses the layers its thumbnails
 * loaded; another style gets a loader of its own that goes when its picture
 * is done.
 *
 * Trait thumbnails come first. Character pictures wait in a queue of their
 * own and run in a loop of their own, so a trait request never waits behind
 * one. A character picture loads its layers alongside the thumbnails, and
 * waits to composite until no thumbnail request is running or waiting.
 */
import { drawThumbnail, layerBounds, thumbnailSources, traitTiles } from '../src/thumbnails.js';
import { baseLayers, basePicture, mayDrawBase, reusesThumbnailLayers } from '../src/builder-layout.js';
import { THUMBNAIL_LAYER_BYTES } from '../src/layer-cache.js';
import { createLayerLoader } from './layers.js';

let latest = 0;
/** The trait thumbnail requests. @type {object[]} */
const queue = [];
let running = false;
/** The character picture requests, behind every trait request. @type {object[]} */
const baseQueue = [];
let basesRunning = false;

/** The layers and their bounds of the style the last request was for. */
let style = null;

function styleFor(manifest, manifestUrl) {
  if (!style || style.manifestUrl !== manifestUrl) {
    style = { manifestUrl, layers: createLayerLoader(manifest, manifestUrl, THUMBNAIL_LAYER_BYTES), bounds: new Map() };
  }
  return style;
}

/** Let the next message in, so a newer request can stop this one. */
function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function drawGroup(request) {
  const { manifest, manifestUrl, selection, groupId } = request;
  const group = manifest.groups.find((item) => item.id === groupId);
  const { layers, bounds } = styleFor(manifest, manifestUrl);
  const sources = thumbnailSources(manifest, selection, group);
  const loaded = new Map(await Promise.all(sources.map(async (src) => [src, await layers.get(src)])));
  const pixelsOf = (src) => loaded.get(src);
  // A layer's bounds never change, so they are kept after its pixels are dropped.
  const boundsOf = (src) => {
    if (!bounds.has(src)) bounds.set(src, layerBounds(loaded.get(src)));
    return bounds.get(src);
  };
  const tiles = [];
  for (const tile of traitTiles(group)) {
    if (request.ticket < latest) return null;
    const { width, height, data } = drawThumbnail({ manifest, selection, group, choice: tile.choice, pixelsOf, boundsOf });
    tiles.push({ value: tile.value, width, height, data });
    await nextTask();
  }
  return request.ticket < latest ? null : tiles;
}

/** The picture on a style's tile in the character row. */
async function drawBase(request) {
  const { manifest, manifestUrl } = request;
  const layers = reusesThumbnailLayers(style?.manifestUrl ?? null, manifestUrl)
    ? style.layers
    : createLayerLoader(manifest, manifestUrl, THUMBNAIL_LAYER_BYTES);
  const sources = baseLayers(manifest).map(({ option }) => option.src);
  const loaded = new Map(await Promise.all(sources.map(async (src) => [src, await layers.get(src)])));
  // Trait thumbnails go first: composite only while none is running or waiting.
  while (!mayDrawBase({ running, waiting: queue.length })) await nextTask();
  return basePicture(manifest, (src) => loaded.get(src));
}

async function runBases() {
  basesRunning = true;
  while (baseQueue.length > 0) {
    const request = baseQueue.shift();
    try {
      const { width, height, data } = await drawBase(request);
      self.postMessage({ type: 'base', id: request.id, width, height, data }, [data.buffer]);
    } catch (error) {
      self.postMessage({ type: 'base-error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
    await nextTask();
  }
  basesRunning = false;
}

async function run() {
  running = true;
  while (queue.length > 0) {
    const request = queue.shift();
    if (request.ticket < latest) continue;
    try {
      const tiles = await drawGroup(request);
      if (tiles) {
        const { ticket, groupId, key } = request;
        self.postMessage({ type: 'tiles', ticket, groupId, key, tiles }, tiles.map((tile) => tile.data.buffer));
      }
    } catch (error) {
      self.postMessage({ type: 'error', ticket: request.ticket, message: error instanceof Error ? error.message : String(error) });
    }
  }
  running = false;
}

self.addEventListener('message', (event) => {
  const request = event.data;
  if (request.kind === 'base') {
    baseQueue.push(request);
    if (!basesRunning) runBases();
    return;
  }
  latest = Math.max(latest, request.ticket);
  queue.push(request);
  if (!running) run();
});

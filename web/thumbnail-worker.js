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
 */
import { drawThumbnail, layerBounds, thumbnailSources, traitTiles } from '../src/thumbnails.js';
import { THUMBNAIL_LAYER_BYTES } from '../src/layer-cache.js';
import { createLayerLoader } from './layers.js';

let latest = 0;
/** @type {object[]} */
const queue = [];
let running = false;

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
  latest = Math.max(latest, request.ticket);
  queue.push(request);
  if (!running) run();
});

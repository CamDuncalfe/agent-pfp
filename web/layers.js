/**
 * Reads layer images in the browser. The builder page and the thumbnail
 * worker both load layers through this file, so a layer path turns into a
 * file one way (resolveLayerUrl) and is read one way.
 */
import { resolveLayerUrl } from '../src/manifest.js';
import { createLayerCache } from '../src/layer-cache.js';

/**
 * Load one layer image and read its pixels at the manifest's canvas size.
 * A layer of another size is refused, the same way the render check refuses it.
 *
 * The pixels come back through a 2D canvas, which stores premultiplied
 * alpha. Alpha values and opaque pixels come back exact. The colour of a
 * see-through pixel can shift by a few levels (see docs/render-check.md).
 */
export async function loadLayerPixels(url, canvas) {
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

/**
 * The layers of one style, read on first use and kept up to `maxBytes`.
 * @param {import('../src/manifest.js').Manifest} manifest
 * @param {string | URL} manifestUrl
 * @param {number} maxBytes
 */
export function createLayerLoader(manifest, manifestUrl, maxBytes) {
  return createLayerCache((src) => loadLayerPixels(resolveLayerUrl(src, manifestUrl), manifest.canvas), maxBytes);
}

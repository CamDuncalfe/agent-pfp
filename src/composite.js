/**
 * Compositing on plain RGBA pixel buffers. The builder page and the render
 * check both call compositeLayers, so the check tests the same pixels a user
 * downloads.
 *
 * A raster is `{ width, height, data }` where `data` holds 4 bytes per pixel
 * (red, green, blue, alpha), row by row from the top left, with straight
 * (not premultiplied) alpha. A browser ImageData object has this shape.
 */

/**
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray | Uint8Array }} Raster
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Raster} a fully transparent raster
 */
export function createRaster(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('raster width and height must be positive integers');
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * @param {unknown} raster
 * @returns {raster is Raster}
 */
export function isRaster(raster) {
  return (
    typeof raster === 'object' &&
    raster !== null &&
    Number.isInteger(raster.width) &&
    Number.isInteger(raster.height) &&
    raster.width > 0 &&
    raster.height > 0 &&
    ArrayBuffer.isView(raster.data) &&
    raster.data.length === raster.width * raster.height * 4
  );
}

/**
 * Draw layers on top of each other, first layer at the bottom, with the
 * standard "source over" rule. Every layer has to be exactly width x height:
 * layers are full-canvas images, so there is no offset to get wrong.
 *
 * @param {number} width
 * @param {number} height
 * @param {Raster[]} layers
 * @returns {Raster}
 */
export function compositeLayers(width, height, layers) {
  const out = createRaster(width, height);
  const dst = out.data;
  layers.forEach((layer, index) => {
    if (!isRaster(layer)) {
      throw new TypeError(`layer ${index} is not an RGBA raster`);
    }
    if (layer.width !== width || layer.height !== height) {
      throw new RangeError(
        `layer ${index} is ${layer.width}x${layer.height}, expected ${width}x${height}`,
      );
    }
    const src = layer.data;
    for (let i = 0; i < dst.length; i += 4) {
      const sa = src[i + 3];
      if (sa === 0) continue;
      const da = dst[i + 3];
      if (sa === 255 || da === 0) {
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = sa;
        continue;
      }
      // Alpha values are 0-255, so both weights below are scaled by 255.
      const srcWeight = sa * 255;
      const dstWeight = da * (255 - sa);
      const total = srcWeight + dstWeight;
      dst[i] = Math.round((src[i] * srcWeight + dst[i] * dstWeight) / total);
      dst[i + 1] = Math.round((src[i + 1] * srcWeight + dst[i + 1] * dstWeight) / total);
      dst[i + 2] = Math.round((src[i + 2] * srcWeight + dst[i + 2] * dstWeight) / total);
      dst[i + 3] = Math.round(total / 255);
    }
  });
  return out;
}

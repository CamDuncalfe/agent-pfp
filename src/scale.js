/**
 * Scaling a finished picture down. Download uses it to make a smaller file
 * from the picture compositeLayers drew at canvas size, and the round
 * preview uses it on the middle square of that picture, which it reads
 * straight out of the picture. It is never used on a layer: layers are drawn
 * at full size (AGENTS.md rule 1).
 *
 * This module has no Node or browser dependencies.
 */
import { createRaster, isRaster } from './composite.js';

/**
 * How much of each source pixel falls inside each target pixel along one
 * axis. Lengths are counted in units of 1/target of a source pixel, so the
 * weights are whole numbers and the weights of one target pixel add up to
 * `source`.
 * @param {number} source
 * @param {number} target
 * @returns {{ index: number, weight: number }[][]} one list per target pixel
 */
function spans(source, target) {
  const list = [];
  for (let t = 0; t < target; t += 1) {
    const start = t * source;
    const end = start + source;
    const span = [];
    for (let s = Math.floor(start / target); s * target < end; s += 1) {
      const weight = Math.min((s + 1) * target, end) - Math.max(s * target, start);
      span.push({ index: s, weight });
    }
    list.push(span);
  }
  return list;
}

/**
 * Scale a picture down to width x height. Each target pixel is the average
 * of the source pixels it covers, weighted by the area covered. Colour is
 * also weighted by alpha, so a see-through pixel adds no colour to the
 * pixels next to it.
 *
 * A one-colour picture comes out the same colour and an opaque picture comes
 * out opaque. A target of the picture's own size gives a copy.
 *
 * With `part`, only that rectangle of the picture is read and scaled, as if
 * it had been cut out first. The pixels are read where they are, so no copy
 * of the rectangle is made.
 *
 * @param {import('./composite.js').Raster} picture straight (not premultiplied) alpha
 * @param {number} width
 * @param {number} height
 * @param {{ x: number, y: number, width: number, height: number }} [part]
 *   the rectangle of the picture to scale, in pixels. Left out, it is the whole picture.
 * @returns {import('./composite.js').Raster} a new raster, `picture` is left as it is
 */
export function scaleDown(picture, width, height, part) {
  if (!isRaster(picture)) {
    throw new TypeError('the picture is not an RGBA raster');
  }
  const from = part ?? { x: 0, y: 0, width: picture.width, height: picture.height };
  if (
    ![from.x, from.y, from.width, from.height].every(Number.isInteger) ||
    from.x < 0 ||
    from.y < 0 ||
    from.width <= 0 ||
    from.height <= 0 ||
    from.x + from.width > picture.width ||
    from.y + from.height > picture.height
  ) {
    throw new RangeError(`the part to scale is not a rectangle inside the ${picture.width}x${picture.height} picture`);
  }
  const out = createRaster(width, height);
  if (width > from.width || height > from.height) {
    throw new RangeError(`cannot scale a ${from.width}x${from.height} picture down to ${width}x${height}`);
  }
  const src = picture.data;
  const dst = out.data;
  const columns = spans(from.width, width);
  const rows = spans(from.height, height);
  const area = from.width * from.height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (const row of rows[y]) {
        for (const column of columns[x]) {
          const i = ((from.y + row.index) * picture.width + from.x + column.index) * 4;
          const share = row.weight * column.weight * src[i + 3];
          if (share === 0) continue;
          red += src[i] * share;
          green += src[i + 1] * share;
          blue += src[i + 2] * share;
          alpha += share;
        }
      }
      const outAlpha = Math.round(alpha / area);
      // A pixel that comes out fully see-through carries no colour.
      if (outAlpha === 0) continue;
      const o = (y * width + x) * 4;
      dst[o] = Math.round(red / alpha);
      dst[o + 1] = Math.round(green / alpha);
      dst[o + 2] = Math.round(blue / alpha);
      dst[o + 3] = outAlpha;
    }
  }
  return out;
}

/**
 * The small round preview: the part of the finished picture GitHub shows as
 * a profile picture. GitHub cuts a picture that isn't square to a square
 * from its middle, resizes it and rounds it. This module finds the square,
 * copies a small one and scales a big one down. The page rounds it and sets its size on screen in
 * web/builder.css.
 *
 * The square is cut from the picture compositeLayers drew at canvas size.
 * No layer is drawn or scaled here (AGENTS.md rules 1 and 3).
 *
 * This module has no Node or browser dependencies.
 */
import { createRaster, isRaster } from './composite.js';
import { scaleDown } from './scale.js';

/**
 * How wide the round preview is on screen, in CSS pixels. web/builder.css
 * sets the size, and a test keeps the two the same.
 */
export const ROUND_PREVIEW_WIDTH = 96;

/**
 * The most pixels the round preview holds along a side: two for each CSS
 * pixel, enough for a screen that draws two pixels per CSS pixel. A bigger
 * square is averaged down to this with scaleDown, because a browser that
 * shrinks a big canvas to 96 px on its own breaks up thin lines.
 */
export const ROUND_PREVIEW_MAX_SIDE = ROUND_PREVIEW_WIDTH * 2;

/**
 * The biggest square in the middle of a canvas. When the room left over is
 * an odd number of pixels, the extra one stays on the right or at the bottom.
 * @param {{ width: number, height: number }} canvas
 * @returns {{ x: number, y: number, side: number }} top left corner and side, in pixels
 */
export function middleSquare(canvas) {
  const { width, height } = canvas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('canvas width and height must be positive integers');
  }
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/**
 * The width and height of the round preview's picture, in pixels: the side
 * of the middle square, or ROUND_PREVIEW_MAX_SIDE when the square is bigger.
 * @param {{ width: number, height: number }} canvas
 * @returns {number}
 */
export function roundPreviewSide(canvas) {
  return Math.min(middleSquare(canvas).side, ROUND_PREVIEW_MAX_SIDE);
}

/**
 * The picture the round preview shows: the middle square of the finished
 * picture. A square of up to ROUND_PREVIEW_MAX_SIDE pixels is copied pixel
 * for pixel. A bigger one is scaled down to that size. scaleDown reads it
 * straight out of the picture, so the biggest raster made here is
 * ROUND_PREVIEW_MAX_SIDE pixels a side, whatever the size of the canvas.
 * @param {import('./composite.js').Raster} picture the picture compositeLayers drew
 * @returns {import('./composite.js').Raster} a new raster, `picture` is left as it is
 */
export function roundPreviewPicture(picture) {
  if (!isRaster(picture)) {
    throw new TypeError('the picture is not an RGBA raster');
  }
  const { x, y, side } = middleSquare(picture);
  const target = roundPreviewSide(picture);
  if (target < side) {
    return scaleDown(picture, target, target, { x, y, width: side, height: side });
  }
  const square = createRaster(side, side);
  for (let row = 0; row < side; row += 1) {
    const start = ((y + row) * picture.width + x) * 4;
    square.data.set(picture.data.subarray(start, start + side * 4), row * side * 4);
  }
  return square;
}

/**
 * The middle square of a canvas: the part GitHub shows as a profile
 * picture, rounded, when a picture isn't square. The preview's Circle
 * switch shows the circle inside this square: web/builder.css clips the
 * preview with `circle(closest-side)`, which is the same circle. The
 * thumbnail of a layer that covers the whole canvas is this square too.
 *
 * Nothing is drawn or scaled here (AGENTS.md rules 1 and 3).
 *
 * This module has no Node or browser dependencies.
 */

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

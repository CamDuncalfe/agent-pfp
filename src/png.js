/**
 * PNG files to and from rasters. Node only: the builder page reads pixels
 * through a canvas instead.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

/**
 * @param {string | URL} path
 * @returns {Promise<import('./composite.js').Raster>}
 */
export async function readPng(path) {
  const png = PNG.sync.read(await readFile(path));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
  };
}

/**
 * @param {string | URL} path
 * @param {import('./composite.js').Raster} raster
 */
export async function writePng(path, raster) {
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data.set(raster.data);
  await writeFile(path, PNG.sync.write(png));
}

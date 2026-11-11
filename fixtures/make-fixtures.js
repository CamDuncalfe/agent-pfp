#!/usr/bin/env node
/**
 * Draws the fixture layers. These are plain shapes for tests. They are not
 * artwork and do not ship in a style.
 *
 *   fixtures/shapes  a small style that passes the render check
 *   fixtures/broken  the same idea with one layer for each kind of failure
 *
 * Run `npm run fixtures` to write the PNG files again after changing a shape.
 * test/fixtures.test.js fails when the files on disk and this script disagree.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRaster } from '../src/composite.js';

const SIZE = 64;

const GREY = [200, 204, 212, 255];
const BLUE = [120, 160, 230, 255];
const SKIN = [245, 214, 160, 255];
const INK = [30, 30, 36, 255];
const RED = [210, 70, 60, 255];
const CLEAR = [0, 0, 0, 0];

function rect(raster, x, y, width, height, colour) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
      raster.data.set(colour, (py * raster.width + px) * 4);
    }
  }
  return raster;
}

function circle(raster, centreX, centreY, radius, colour) {
  for (let py = 0; py < raster.height; py += 1) {
    for (let px = 0; px < raster.width; px += 1) {
      if ((px - centreX) ** 2 + (py - centreY) ** 2 <= radius ** 2) {
        raster.data.set(colour, (py * raster.width + px) * 4);
      }
    }
  }
  return raster;
}

function layer(draw, size = SIZE) {
  const raster = createRaster(size, size);
  draw(raster);
  return raster;
}

const torso = (raster) => rect(raster, 16, 50, 32, 14, SKIN);
const roundBody = (raster) => torso(circle(raster, 32, 30, 18, SKIN));
const dots = (raster) => rect(rect(raster, 22, 26, 4, 4, INK), 38, 26, 4, 4, INK);
const line = (raster) => rect(raster, 24, 39, 16, 2, INK);

/**
 * @returns {Record<string, import('../src/composite.js').Raster>} rasters keyed by path under fixtures/
 */
export function buildFixtures() {
  return {
    // A style that passes.
    'shapes/layers/background/grey.png': layer((r) => rect(r, 0, 0, SIZE, SIZE, GREY)),
    'shapes/layers/background/blue.png': layer((r) => rect(r, 0, 0, SIZE, SIZE, BLUE)),
    'shapes/layers/body/round.png': layer(roundBody),
    'shapes/layers/body/square.png': layer((r) => torso(rect(r, 14, 12, 36, 36, SKIN))),
    'shapes/layers/eyes/dots.png': layer(dots),
    'shapes/layers/eyes/bars.png': layer((r) => rect(rect(r, 20, 27, 8, 3, INK), 36, 27, 8, 3, INK)),
    'shapes/layers/mouth/line.png': layer(line),
    'shapes/layers/mouth/open.png': layer((r) => rect(r, 27, 37, 10, 6, INK)),
    'shapes/layers/headwear/cap.png': layer((r) => rect(rect(r, 14, 10, 36, 6, RED), 48, 14, 4, 2, RED)),
    'shapes/layers/headwear/tall.png': layer((r) => rect(rect(r, 22, 4, 20, 8, RED), 13, 12, 38, 4, RED)),

    // One layer for each kind of failure.
    'broken/layers/background/grey.png': layer((r) => rect(r, 0, 0, SIZE, SIZE, GREY)),
    // hole: a see-through square nothing else covers
    'broken/layers/background/holed.png': layer((r) => rect(rect(r, 0, 0, SIZE, SIZE, GREY), 2, 2, 4, 4, CLEAR)),
    'broken/layers/body/round.png': layer(roundBody),
    'broken/layers/eyes/dots.png': layer(dots),
    // zone: eyes drawn wider than the eye zone
    'broken/layers/eyes/wide.png': layer((r) => rect(rect(r, 12, 26, 8, 4, INK), 44, 26, 8, 4, INK)),
    'broken/layers/mouth/line.png': layer(line),
    // size: exported at half the canvas size
    'broken/layers/mouth/offsize.png': layer((r) => rect(r, 12, 19, 8, 1, INK), SIZE / 2),
    // clip: a hat that runs off the top of the canvas
    'broken/layers/headwear/clipped.png': layer((r) => rect(r, 22, 0, 20, 18, RED)),
    // overlap: a hat that comes down over the eyes without saying so
    'broken/layers/headwear/low.png': layer((r) => rect(r, 16, 20, 32, 8, RED)),
    // empty: nothing drawn
    'broken/layers/headwear/blank.png': layer(() => {}),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { writePng } = await import('../src/png.js');
  const root = dirname(fileURLToPath(import.meta.url));
  for (const [path, raster] of Object.entries(buildFixtures())) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writePng(target, raster);
    console.log(`wrote fixtures/${path}`);
  }
}

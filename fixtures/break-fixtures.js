/**
 * Broken copies of the clean fixture styles, made in memory to show that the
 * render check catches every way a layer can go wrong.
 *
 * Each copy changes one layer of a clean style in one way and leaves the
 * manifest and every other layer as they are. Nothing is written to disk.
 *
 *   clip     the layer is moved past a canvas edge its group doesn't list in `bleed`
 *   zone     the layer is moved a few pixels so part of it sits outside its group's zone
 *   overlap  the layer is grown until it shares pixels with a layer of a group it may not cover
 *   hole     a see-through patch is cut in a bottom layer of a style with an opaque canvas
 *   size     the layer is saved a few pixels bigger or smaller than the canvas
 *
 * Each break takes a number of pixels: how far the layer moves, how many
 * steps it grows, how wide the hole is or how far the size is off. With 0
 * pixels the copy is the clean style, which the tests use to show that a
 * caught copy is caught because of the break.
 *
 * `npm run check:broken` (bin/check-broken.js) runs the check on every copy.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createRaster } from '../src/composite.js';
import { EDGES, validateManifest } from '../src/manifest.js';
import { checkManifest, DEFAULT_OPTIONS } from '../src/render-check.js';
import { readPng } from '../src/png.js';

/** The ways to break a layer, in the order the command prints them. */
export const WAYS = Object.freeze([
  { id: 'clip', label: 'Clipped', kind: 'clip' },
  { id: 'zone', label: 'Off its anchor', kind: 'zone' },
  { id: 'overlap', label: "Into another trait's area", kind: 'overlap' },
  { id: 'hole', label: 'Hole', kind: 'hole' },
  { id: 'size', label: 'Wrong canvas size', kind: 'size' },
]);

const THRESHOLD = DEFAULT_OPTIONS.alphaThreshold;
const MOVES = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
/** How far past an edge a clipped layer goes, at most. */
const CLIP_PAST = 2;
/** How far past its zone a moved layer goes. */
const ZONE_PAST = 2;
/** Side of the square cut out for a hole. */
const HOLE_SIZE = 3;
/** How many pixels a wrong-size layer is off the canvas size. */
const SIZE_OFF = 4;

/**
 * @typedef {import('../src/composite.js').Raster} Raster
 * @typedef {{ manifest: any, layers: Map<string, Raster>, id?: string, errors?: Map<string, unknown> }} Style
 *
 * `errors` holds the layers that could not be read, by `src`. `id` names the
 * style when its manifest could not be read.
 * @typedef {{
 *   style: string,
 *   way: string,
 *   kind: string,
 *   group: string,
 *   option: string,
 *   detail: string,
 *   direction: string,
 *   pixels: number,
 * }} Break
 *
 * `direction` is the canvas edge a clip or zone break moves the layer
 * towards, 'bigger' or 'smaller' for a size break, and '' for the others.
 */

function bounds(raster) {
  let minX = raster.width;
  let minY = raster.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (raster.data[(y * raster.width + x) * 4 + 3] < THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function drawn(raster, index) {
  return raster.data[index * 4 + 3] >= THRESHOLD;
}

function touchesEdge(raster, edge) {
  const box = bounds(raster);
  if (!box) return false;
  if (edge === 'top') return box.minY === 0;
  if (edge === 'bottom') return box.maxY === raster.height - 1;
  if (edge === 'left') return box.minX === 0;
  return box.maxX === raster.width - 1;
}

/** Move every pixel by dx, dy. Pixels that leave the canvas are lost. */
export function shiftLayer(raster, dx, dy) {
  const out = createRaster(raster.width, raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= raster.width || ty >= raster.height) continue;
      const from = (y * raster.width + x) * 4;
      out.data.set(raster.data.subarray(from, from + 4), (ty * raster.width + tx) * 4);
    }
  }
  return out;
}

/** Grow the drawn pixels by one pixel per step, each new pixel copying a drawn neighbour. */
export function growLayer(raster, steps) {
  let current = raster;
  for (let step = 0; step < steps; step += 1) {
    const out = { width: current.width, height: current.height, data: new Uint8ClampedArray(current.data) };
    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        const index = y * current.width + x;
        if (drawn(current, index)) continue;
        for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]) {
          if (nx < 0 || ny < 0 || nx >= current.width || ny >= current.height) continue;
          const from = (ny * current.width + nx) * 4;
          if (current.data[from + 3] < THRESHOLD) continue;
          out.data.set(current.data.subarray(from, from + 4), index * 4);
          break;
        }
      }
    }
    current = out;
  }
  return current === raster ? copyLayer(raster) : current;
}

/** Make every pixel of a size x size square at x, y fully see-through. */
export function cutHole(raster, x, y, size) {
  const out = copyLayer(raster);
  for (let py = y; py < y + size; py += 1) {
    for (let px = x; px < x + size; px += 1) {
      if (px < 0 || py < 0 || px >= out.width || py >= out.height) continue;
      out.data.fill(0, (py * out.width + px) * 4, (py * out.width + px) * 4 + 4);
    }
  }
  return out;
}

/** Save the layer at a new size. Each pixel keeps its place, from the top left. */
export function resizeLayer(raster, width, height) {
  const out = createRaster(width, height);
  for (let y = 0; y < Math.min(height, raster.height); y += 1) {
    const from = y * raster.width * 4;
    const length = Math.min(width, raster.width) * 4;
    out.data.set(raster.data.subarray(from, from + length), y * width * 4);
  }
  return out;
}

function copyLayer(raster) {
  return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) };
}

/** True when the check compares this pair of groups, as in src/render-check.js. */
function pairChecked(manifest, groupA, groupB) {
  const a = manifest.groups.indexOf(groupA);
  const b = manifest.groups.indexOf(groupB);
  const [lower, upper] = a < b ? [groupA, groupB] : [groupB, groupA];
  return !lower.base && !(upper.over ?? []).includes(lower.id);
}

function mask(width, height, rasters) {
  const out = new Uint8Array(width * height);
  for (const raster of rasters) {
    for (let i = 0; i < out.length; i += 1) if (drawn(raster, i)) out[i] = 1;
  }
  return out;
}

function shares(raster, other) {
  for (let i = 0; i < other.length; i += 1) if (other[i] && drawn(raster, i)) return true;
  return false;
}

/** The layers of every group but one, as one mask. */
function othersMask(style, group) {
  const { width, height } = style.manifest.canvas;
  const rasters = style.manifest.groups
    .filter((other) => other !== group)
    .flatMap((other) => other.options.map((option) => style.layers.get(option.src)));
  return mask(width, height, rasters);
}

/** The first size x size square that no layer of another group draws on. */
function findHoleSpot(style, group, size) {
  const { width, height } = style.manifest.canvas;
  const covered = othersMask(style, group);
  for (let y = 0; y + size <= height; y += 1) {
    for (let x = 0; x + size <= width; x += 1) {
      let free = true;
      for (let py = y; py < y + size && free; py += 1) {
        for (let px = x; px < x + size; px += 1) {
          if (covered[py * width + px]) {
            free = false;
            break;
          }
        }
      }
      if (free) return { x, y };
    }
  }
  return null;
}

/**
 * List every break that applies to a style: each option layer gets each way
 * that applies to its group, with one copy per edge, direction or size.
 *
 * @param {Style} style
 * @returns {Break[]}
 */
export function planBreaks(style) {
  const { manifest } = style;
  const { width, height } = manifest.canvas;
  /** @type {Break[]} */
  const breaks = [];
  manifest.groups.forEach((group, groupIndex) => {
    const partners = manifest.groups.filter((other) => other !== group && pairChecked(manifest, group, other));
    const partnerMask = mask(
      width,
      height,
      partners.flatMap((other) => other.options.map((option) => style.layers.get(option.src))),
    );
    for (const option of group.options) {
      const raster = style.layers.get(option.src);
      const box = bounds(raster);
      if (!box) throw new Error(`${manifest.style}: ${group.id}/${option.id} has no drawn pixels to break`);
      const add = (way, detail, pixels, direction = '') =>
        breaks.push({
          style: manifest.style,
          way,
          kind: WAYS.find((entry) => entry.id === way).kind,
          group: group.id,
          option: option.id,
          detail,
          direction,
          pixels,
        });

      // clip: one copy per edge the group doesn't list in bleed.
      for (const edge of EDGES) {
        if ((group.bleed ?? []).includes(edge)) continue;
        // Move the layer onto the edge, then up to CLIP_PAST px further, as
        // far as it goes while some of it is still on the edge.
        const gap = { top: box.minY, bottom: height - 1 - box.maxY, left: box.minX, right: width - 1 - box.maxX }[edge];
        const [dx, dy] = MOVES[edge];
        let past = CLIP_PAST;
        while (past > 0 && !touchesEdge(shiftLayer(raster, dx * (gap + past), dy * (gap + past)), edge)) past -= 1;
        add('clip', `${edge} edge`, gap + past, edge);
      }

      // zone: one copy per direction.
      if (group.zone) {
        const { zone } = group;
        const gaps = {
          top: box.minY - zone.y,
          bottom: zone.y + zone.height - 1 - box.maxY,
          left: box.minX - zone.x,
          right: zone.x + zone.width - 1 - box.maxX,
        };
        const words = { top: 'up', bottom: 'down', left: 'left', right: 'right' };
        for (const edge of EDGES) add('zone', `moved ${words[edge]}`, gaps[edge] + ZONE_PAST, edge);
      }

      // overlap: grow until it shares a pixel with a layer of a group it may not cover.
      if (partners.length > 0) {
        let steps = 0;
        let grown = raster;
        const limit = width + height;
        while (!shares(grown, partnerMask)) {
          steps += 1;
          if (steps > limit) throw new Error(`${manifest.style}: ${group.id}/${option.id} never reaches another group`);
          grown = growLayer(grown, 1);
        }
        add('overlap', `grown ${steps} px`, steps);
      }

      // hole: only in the bottom layer of a style with an opaque canvas.
      if (groupIndex === 0 && manifest.canvas.opaque === true) {
        add('hole', `${HOLE_SIZE}x${HOLE_SIZE} px`, HOLE_SIZE);
      }

      // size: one copy bigger and one smaller than the canvas.
      add('size', 'bigger', SIZE_OFF, 'bigger');
      add('size', 'smaller', SIZE_OFF, 'smaller');
    }
  });
  return breaks;
}

/**
 * Make the layers of a broken copy. Only the broken layer is new; the others
 * are the clean style's own rasters.
 *
 * @param {Style} style
 * @param {Break} plan
 * @param {number} [pixels] size of the change, `plan.pixels` by default. 0 gives the clean style.
 * @returns {Map<string, Raster>}
 */
export function applyBreak(style, plan, pixels = plan.pixels) {
  const { manifest } = style;
  const group = manifest.groups.find((entry) => entry.id === plan.group);
  const option = group.options.find((entry) => entry.id === plan.option);
  const raster = style.layers.get(option.src);
  let broken;
  if (plan.way === 'clip' || plan.way === 'zone') {
    const [dx, dy] = MOVES[plan.direction];
    broken = shiftLayer(raster, dx * pixels, dy * pixels);
  } else if (plan.way === 'overlap') {
    broken = growLayer(raster, pixels);
  } else if (plan.way === 'hole') {
    const spot = findHoleSpot(style, group, Math.max(pixels, 1));
    if (!spot) throw new Error(`${manifest.style}: no spot for a hole in ${group.id}/${option.id}`);
    broken = cutHole(raster, spot.x, spot.y, pixels);
  } else if (plan.way === 'size') {
    const change = plan.direction === 'bigger' ? pixels : -pixels;
    broken = resizeLayer(raster, raster.width + change, raster.height + change);
  } else {
    throw new Error(`unknown way to break a layer: ${plan.way}`);
  }
  const layers = new Map(style.layers);
  layers.set(option.src, broken);
  return layers;
}

/**
 * Read a style and its layers from disk.
 * @param {string} manifestPath
 * @returns {Promise<Style>}
 */
export async function loadStyle(manifestPath, id = manifestPath) {
  const layers = new Map();
  const errors = new Map();
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    // The render check reports a manifest it cannot read as a `manifest` issue.
    return { id, manifest: null, layers, errors };
  }
  if (!validateManifest(manifest).ok) return { id, manifest, layers, errors };
  for (const group of manifest.groups) {
    for (const option of group.options) {
      try {
        layers.set(option.src, await readPng(join(dirname(manifestPath), option.src)));
      } catch (error) {
        // Kept for the render check, which reports it as a `missing` issue.
        errors.set(option.src, error);
      }
    }
  }
  return { id, manifest, layers, errors };
}

function loader(layers, errors = new Map()) {
  return (src) => {
    if (errors.has(src)) throw errors.get(src);
    const raster = layers.get(src);
    if (!raster) throw new Error(`no layer ${src}`);
    return raster;
  };
}

/**
 * A copy is caught when the check fails it and reports the kind of issue the
 * copy was made to cause. Other issues on the same copy don't matter.
 *
 * @param {Break} plan
 * @param {import('../src/render-check.js').Report} report
 */
export function isCaught(plan, report) {
  return !report.ok && report.issues.some((issue) => issue.kind === plan.kind);
}

/**
 * Run the render check on each clean style and on every broken copy of it.
 * A clean style that fails gets no broken copies: its layers are not a clean
 * start, and a missing or blank layer has nothing to break.
 *
 * @param {Style[]} styles
 * @returns {Promise<{
 *   clean: { style: string, ok: boolean, reason?: string }[],
 *   copies: (Break & { caught: boolean, kinds: string[] })[],
 *   ok: boolean,
 * }>}
 */
export async function checkBrokenCopies(styles) {
  const clean = [];
  const copies = [];
  for (const style of styles) {
    const report = await checkManifest(style.manifest, loader(style.layers, style.errors));
    const name = report.style ?? style.id ?? '(unnamed style)';
    if (!report.ok) {
      clean.push({ style: name, ok: false, reason: report.issues[0]?.message });
      continue;
    }
    clean.push({ style: name, ok: true });
    for (const plan of planBreaks(style)) {
      const copy = await checkManifest(style.manifest, loader(applyBreak(style, plan)));
      const kinds = [...new Set(copy.issues.map((issue) => issue.kind))];
      copies.push({ ...plan, caught: isCaught(plan, copy), kinds });
    }
  }
  const ok = clean.every((entry) => entry.ok) && copies.every((copy) => copy.caught);
  return { clean, copies, ok };
}

/**
 * The text `npm run check:broken` prints.
 * @param {Awaited<ReturnType<typeof checkBrokenCopies>>} result
 * @returns {string}
 */
export function formatBrokenResult(result) {
  const lines = [];
  for (const way of WAYS) {
    const made = result.copies.filter((copy) => copy.way === way.id);
    const caught = made.filter((copy) => copy.caught).length;
    lines.push(`${way.label} (${way.kind}): ${made.length} copies made, ${caught} caught`);
  }
  for (const copy of result.copies.filter((entry) => !entry.caught)) {
    const found = copy.kinds.length > 0 ? copy.kinds.join(', ') : 'no issues';
    lines.push(`  missed: ${copy.style} ${copy.group}/${copy.option} ${copy.way} (${copy.detail}), the check reported ${found}`);
  }
  for (const entry of result.clean.filter((style) => !style.ok)) {
    lines.push(`  clean style failed: ${entry.style}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  const caught = result.copies.filter((copy) => copy.caught).length;
  const passed = result.clean.filter((entry) => entry.ok).length;
  lines.push(
    `Broken styles caught: ${caught} of ${result.copies.length}. Clean styles passed: ${passed} of ${result.clean.length}.`,
  );
  return lines.join('\n');
}

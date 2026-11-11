/**
 * Render check: decides whether a style's layers can be combined safely.
 *
 * It looks at three things, from cheapest to most expensive:
 *
 * 1. Each layer on its own: right size, not blank, not cut off by a canvas
 *    edge, inside its group's zone.
 * 2. Each pair of layers from different groups: they may only share pixels
 *    when the manifest allows it (`base` or `over`).
 * 3. Each combination a user can pick: it is composited the way the builder
 *    draws it, and on an opaque canvas the result may not have see-through
 *    pixels.
 *
 * The format fields it reads are documented in docs/manifest.md.
 */
import { validateManifest, resolveSelection, EDGES } from './manifest.js';
import { compositeLayers, isRaster } from './composite.js';
import { countCombinations, walkCombinations, sampleCombinations } from './combinations.js';

export const DEFAULT_OPTIONS = Object.freeze({
  /** A pixel counts as drawn when its alpha is at least this (1-255). */
  alphaThreshold: 16,
  /** Number of shared pixels two layers may have before it counts as overlap. */
  overlapTolerance: 0,
  /** Above this many combinations the check samples instead of visiting all. */
  maxCombinations: 2000,
  /** Seed for the sample, so a failing run can be repeated. */
  seed: 1,
});

/**
 * @typedef {'manifest' | 'missing' | 'size' | 'empty' | 'clip' | 'zone' | 'overlap' | 'hole'} IssueKind
 * @typedef {{
 *   kind: IssueKind,
 *   message: string,
 *   group?: string,
 *   option?: string,
 *   otherGroup?: string,
 *   otherOption?: string,
 *   edge?: string,
 *   pixels?: number,
 *   selection?: import('./manifest.js').Selection,
 * }} Issue
 *
 * In a report, `combinations.total` is null when the style allows more
 * combinations than a number can count exactly (above 2^53).
 *
 * @typedef {{
 *   ok: boolean,
 *   style: string | null,
 *   layers: number,
 *   pairs: number,
 *   combinations: { total: number | null, checked: number, failed: number, exhaustive: boolean },
 *   issues: Issue[],
 * }} Report
 */

function readOptions(options) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  if (!Number.isInteger(merged.alphaThreshold) || merged.alphaThreshold < 1 || merged.alphaThreshold > 255) {
    throw new RangeError('alphaThreshold must be an integer from 1 to 255');
  }
  if (!Number.isInteger(merged.overlapTolerance) || merged.overlapTolerance < 0) {
    throw new RangeError('overlapTolerance must be an integer of 0 or more');
  }
  if (!Number.isInteger(merged.maxCombinations) || merged.maxCombinations < 1) {
    throw new RangeError('maxCombinations must be a positive integer');
  }
  if (!Number.isInteger(merged.seed)) {
    throw new RangeError('seed must be an integer');
  }
  return merged;
}

/**
 * Find the drawn pixels of a layer.
 * @param {import('./composite.js').Raster} raster
 * @param {number} alphaThreshold
 * @returns {{
 *   mask: Uint8Array,
 *   count: number,
 *   bounds: { minX: number, minY: number, maxX: number, maxY: number } | null,
 *   edges: Record<string, number>,
 * }}
 */
export function analyzeLayer(raster, alphaThreshold = DEFAULT_OPTIONS.alphaThreshold) {
  const { width, height, data } = raster;
  const mask = new Uint8Array(width * height);
  const edges = { top: 0, right: 0, bottom: 0, left: 0 };
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (data[index * 4 + 3] < alphaThreshold) continue;
      mask[index] = 1;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y === 0) edges.top += 1;
      if (y === height - 1) edges.bottom += 1;
      if (x === 0) edges.left += 1;
      if (x === width - 1) edges.right += 1;
    }
  }
  return { mask, count, bounds: count === 0 ? null : { minX, minY, maxX, maxY }, edges };
}

function countOutsideZone(analysis, width, zone) {
  if (!analysis.bounds) return 0;
  const { minX, minY, maxX, maxY } = analysis.bounds;
  const zoneRight = zone.x + zone.width - 1;
  const zoneBottom = zone.y + zone.height - 1;
  if (minX >= zone.x && maxX <= zoneRight && minY >= zone.y && maxY <= zoneBottom) return 0;
  let outside = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!analysis.mask[y * width + x]) continue;
      if (x < zone.x || x > zoneRight || y < zone.y || y > zoneBottom) outside += 1;
    }
  }
  return outside;
}

/**
 * Count the pixels two same-size layers both draw.
 */
function countShared(a, b, width) {
  if (!a.bounds || !b.bounds) return 0;
  const minX = Math.max(a.bounds.minX, b.bounds.minX);
  const maxX = Math.min(a.bounds.maxX, b.bounds.maxX);
  const minY = Math.max(a.bounds.minY, b.bounds.minY);
  const maxY = Math.min(a.bounds.maxY, b.bounds.maxY);
  let shared = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = y * width + x;
      if (a.mask[index] && b.mask[index]) shared += 1;
    }
  }
  return shared;
}

function layerKey(groupId, optionId) {
  return `${groupId}/${optionId}`;
}

function describeSelection(selection) {
  return Object.entries(selection)
    .map(([group, option]) => `${group}=${option ?? 'none'}`)
    .join(', ');
}

/**
 * Check one layer against its group's rules.
 * @returns {Issue[]}
 */
function checkLayer(group, option, analysis) {
  const issues = [];
  const where = { group: group.id, option: option.id };
  if (analysis.count === 0) {
    issues.push({ kind: 'empty', ...where, message: `${group.id}/${option.id} has no drawn pixels` });
    return issues;
  }
  const bleed = group.bleed ?? [];
  for (const edge of EDGES) {
    const pixels = analysis.edges[edge];
    if (pixels > 0 && !bleed.includes(edge)) {
      issues.push({
        kind: 'clip',
        ...where,
        edge,
        pixels,
        message: `${group.id}/${option.id} is cut off by the ${edge} edge (${pixels} px on the edge)`,
      });
    }
  }
  return issues;
}

/**
 * Run the render check on one style.
 *
 * @param {unknown} manifest parsed manifest.json
 * @param {(src: string) => import('./composite.js').Raster | Promise<import('./composite.js').Raster>} loadLayer
 *   returns the pixels of a layer, given its `src` from the manifest
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {Promise<Report>}
 */
export async function checkManifest(manifest, loadLayer, options = {}) {
  const settings = readOptions(options);
  /** @type {Issue[]} */
  const issues = [];
  const report = {
    ok: false,
    style: null,
    layers: 0,
    pairs: 0,
    combinations: { total: 0, checked: 0, failed: 0, exhaustive: true },
    issues,
  };

  const validation = validateManifest(manifest);
  if (!validation.ok) {
    for (const error of validation.errors) issues.push({ kind: 'manifest', message: error });
    return report;
  }
  report.style = manifest.style;
  const { width, height } = manifest.canvas;

  // 1. Each layer on its own.
  /** @type {Map<string, { raster: import('./composite.js').Raster, analysis: ReturnType<typeof analyzeLayer> }>} */
  const usable = new Map();
  const failedLayers = new Set();
  for (const group of manifest.groups) {
    for (const option of group.options) {
      report.layers += 1;
      const key = layerKey(group.id, option.id);
      const where = { group: group.id, option: option.id };
      let raster;
      try {
        raster = await loadLayer(option.src);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        issues.push({ kind: 'missing', ...where, message: `${key} could not be loaded from ${option.src}: ${reason}` });
        failedLayers.add(key);
        continue;
      }
      if (!isRaster(raster)) {
        issues.push({ kind: 'missing', ...where, message: `${key} did not load as an RGBA image (${option.src})` });
        failedLayers.add(key);
        continue;
      }
      if (raster.width !== width || raster.height !== height) {
        issues.push({
          kind: 'size',
          ...where,
          message: `${key} is ${raster.width}x${raster.height}, the canvas is ${width}x${height}`,
        });
        failedLayers.add(key);
        continue;
      }
      const analysis = analyzeLayer(raster, settings.alphaThreshold);
      usable.set(key, { raster, analysis });
      const layerIssues = checkLayer(group, option, analysis);
      if (group.zone) {
        const outside = countOutsideZone(analysis, width, group.zone);
        if (outside > 0) {
          layerIssues.push({
            kind: 'zone',
            ...where,
            pixels: outside,
            message: `${key} draws ${outside} px outside the ${group.id} zone`,
          });
        }
      }
      if (layerIssues.length > 0) failedLayers.add(key);
      issues.push(...layerIssues);
    }
  }

  // 2. Each pair of layers from two different groups.
  const failedPairs = new Set();
  manifest.groups.forEach((upper, upperIndex) => {
    for (let lowerIndex = 0; lowerIndex < upperIndex; lowerIndex += 1) {
      const lower = manifest.groups[lowerIndex];
      if (lower.base || (upper.over ?? []).includes(lower.id)) continue;
      for (const lowerOption of lower.options) {
        const a = usable.get(layerKey(lower.id, lowerOption.id));
        if (!a) continue;
        for (const upperOption of upper.options) {
          const b = usable.get(layerKey(upper.id, upperOption.id));
          if (!b) continue;
          report.pairs += 1;
          const shared = countShared(a.analysis, b.analysis, width);
          if (shared > settings.overlapTolerance) {
            const lowerKey = layerKey(lower.id, lowerOption.id);
            const upperKey = layerKey(upper.id, upperOption.id);
            failedPairs.add(`${lowerKey}|${upperKey}`);
            issues.push({
              kind: 'overlap',
              group: upper.id,
              option: upperOption.id,
              otherGroup: lower.id,
              otherOption: lowerOption.id,
              pixels: shared,
              message: `${upperKey} covers ${shared} px of ${lowerKey}, and "${upper.id}" does not list "${lower.id}" in "over"`,
            });
          }
        }
      }
    }
  });

  // 3. Each combination a user can pick.
  const total = countCombinations(manifest);
  const exhaustive = total <= settings.maxCombinations;
  // Infinity does not survive JSON, so a count too large to hold is reported as null.
  report.combinations.total = Number.isFinite(total) ? total : null;
  report.combinations.exhaustive = exhaustive;
  const selections = exhaustive
    ? walkCombinations(manifest)
    : sampleCombinations(manifest, settings.maxCombinations, settings.seed);
  for (const selection of selections) {
    report.combinations.checked += 1;
    const layers = resolveSelection(manifest, selection);
    const keys = layers.map(({ group, option }) => layerKey(group.id, option.id));
    let failed = keys.some((key) => failedLayers.has(key));
    for (let i = 0; i < keys.length && !failed; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (failedPairs.has(`${keys[i]}|${keys[j]}`)) {
          failed = true;
          break;
        }
      }
    }
    // A combination with a layer that is missing or the wrong size cannot be drawn.
    const drawable = keys.every((key) => usable.has(key));
    if (drawable && manifest.canvas.opaque === true) {
      const picture = compositeLayers(
        width,
        height,
        keys.map((key) => usable.get(key).raster),
      );
      let seeThrough = 0;
      for (let i = 3; i < picture.data.length; i += 4) {
        if (picture.data[i] < 255) seeThrough += 1;
      }
      if (seeThrough > 0) {
        failed = true;
        issues.push({
          kind: 'hole',
          pixels: seeThrough,
          selection,
          message: `${seeThrough} see-through px in the finished picture for ${describeSelection(selection)}`,
        });
      }
    }
    if (failed) report.combinations.failed += 1;
  }

  report.ok = issues.length === 0;
  return report;
}

/**
 * Plain-text summary of a report, for the command line and CI logs.
 * @param {Report} report
 * @param {{ maxPerKind?: number }} [options]
 * @returns {string}
 */
export function formatReport(report, { maxPerKind = 20 } = {}) {
  const lines = [];
  const { combinations } = report;
  lines.push(`Style: ${report.style ?? '(manifest not valid)'}`);
  lines.push(`Layers checked: ${report.layers}`);
  lines.push(`Layer pairs checked: ${report.pairs}`);
  const total = combinations.total === null ? 'more than 2^53' : String(combinations.total);
  const scope = combinations.exhaustive
    ? `all ${total}`
    : `a sample of ${combinations.checked} different ones out of ${total}`;
  lines.push(`Combinations checked: ${scope}, ${combinations.failed} failed`);
  if (report.ok) {
    lines.push('Render check passed.');
    return lines.join('\n');
  }
  const byKind = new Map();
  for (const issue of report.issues) {
    if (!byKind.has(issue.kind)) byKind.set(issue.kind, []);
    byKind.get(issue.kind).push(issue);
  }
  for (const [kind, list] of byKind) {
    lines.push('');
    lines.push(`${kind} (${list.length})`);
    for (const issue of list.slice(0, maxPerKind)) lines.push(`  - ${issue.message}`);
    if (list.length > maxPerKind) lines.push(`  ... and ${list.length - maxPerKind} more`);
  }
  lines.push('');
  lines.push(`Render check failed with ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

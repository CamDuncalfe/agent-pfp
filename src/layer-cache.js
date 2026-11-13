/**
 * A cache of decoded layer pixels with a size limit. A decoded layer takes
 * 4 bytes a pixel, so a 1024 px layer is 4 MiB, and a style's options can
 * add up to hundreds of MiB. The cache keeps the layers used last and drops
 * the oldest ones when the bytes it holds go over its limit.
 *
 * This module has no Node or browser dependencies. The builder page and the
 * thumbnail worker each give it their own loader.
 */

const MIB = 2 ** 20;

/**
 * The page's limit. It holds the layers of the picture on screen: the alien
 * has 7 groups, 28 MiB at 1024 px.
 */
export const PAGE_LAYER_BYTES = 32 * MIB;

/**
 * The thumbnail worker's limit. It draws one group at a time and needs the
 * other layers on screen and each option of that group: 17 layers for the
 * alien, 68 MiB at 1024 px.
 */
export const THUMBNAIL_LAYER_BYTES = 80 * MIB;

/**
 * @template {{ data: { byteLength: number } }} T
 * @param {(src: string) => Promise<T> | T} load reads one layer
 * @param {number} maxBytes the most bytes of loaded layers to keep
 * @returns {{ get: (src: string) => Promise<T>, readonly bytes: number, readonly sources: string[] }}
 */
export function createLayerCache(load, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a number of 0 or more');
  /** Oldest first. A layer that is still loading counts 0 bytes. @type {Map<string, { promise: Promise<T>, bytes: number }>} */
  const entries = new Map();
  let total = 0;

  /** Drop the oldest loaded layers until the cache fits, but never `keep`. */
  function trim(keep) {
    for (const [src, entry] of entries) {
      if (total <= maxBytes) return;
      if (src === keep || entry.bytes === 0) continue;
      entries.delete(src);
      total -= entry.bytes;
    }
  }

  return {
    get(src) {
      const found = entries.get(src);
      if (found) {
        // Used now, so it is the newest.
        entries.delete(src);
        entries.set(src, found);
        return found.promise;
      }
      const entry = { promise: null, bytes: 0 };
      entry.promise = Promise.resolve()
        .then(() => load(src))
        .then(
          (raster) => {
            if (entries.get(src) === entry) {
              entry.bytes = raster.data.byteLength;
              total += entry.bytes;
              trim(src);
            }
            return raster;
          },
          (error) => {
            // A failed load is dropped, so the next get tries again.
            if (entries.get(src) === entry) entries.delete(src);
            throw error;
          },
        );
      entries.set(src, entry);
      return entry.promise;
    },
    get bytes() {
      return total;
    },
    get sources() {
      return [...entries.keys()];
    },
  };
}

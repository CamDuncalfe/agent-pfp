/**
 * What Download saves: which sizes a style offers, how big the saved picture
 * is and what the file is called. The builder page reads its Size picker,
 * asks this module and saves the result.
 *
 * The picture is put together once, at canvas size, by compositeLayers. A
 * smaller size is that finished picture scaled down with scaleDown.
 *
 * This module has no Node or browser dependencies.
 */
import { scaleDown } from './scale.js';

/**
 * @typedef {{ id: string, label: string, side: number | null }} DownloadSize
 *   `side` is the width and height in pixels, or null for the canvas size
 */

/** The style's canvas as it is. Each style offers it. */
export const FULL_SIZE = Object.freeze({ id: 'full', label: 'Full size', side: null });

/** The size GitHub recommends for a profile picture. */
export const GITHUB_SIZE = Object.freeze({ id: 'github', label: 'GitHub (500 x 500)', side: 500 });

/** Each size the page knows, in the order the picker lists them. Full size is first. */
export const DOWNLOAD_SIZES = Object.freeze([FULL_SIZE, GITHUB_SIZE]);

/**
 * The sizes a style offers. A fixed size is offered only when the canvas is
 * square and at least that big, so no picture is stretched or cropped.
 * @param {{ width: number, height: number }} canvas the manifest's canvas
 * @returns {DownloadSize[]} Full size first
 */
export function sizesFor(canvas) {
  return DOWNLOAD_SIZES.filter(
    (size) => size.side === null || (canvas.width === canvas.height && canvas.width >= size.side),
  );
}

/**
 * The size a picked id stands for on this canvas. An id the page doesn't
 * know, or a size this canvas doesn't offer, is Full size.
 * @param {{ width: number, height: number }} canvas
 * @param {unknown} pickedId the value of the Size picker
 * @returns {DownloadSize}
 */
export function chooseSize(canvas, pickedId) {
  return sizesFor(canvas).find((size) => size.id === pickedId) ?? FULL_SIZE;
}

/**
 * What the Size picker shows for a style: its options, and the one that is
 * picked. The pick made on the last style is kept when this style offers it
 * too. Otherwise the picker goes back to Full size.
 * @param {{ width: number, height: number }} canvas
 * @param {unknown} pickedId the picker's value before this style opened
 * @returns {{ options: { id: string, label: string }[], value: string }}
 */
export function sizePicker(canvas, pickedId) {
  return {
    options: sizesFor(canvas).map(({ id, label }) => ({ id, label })),
    value: chooseSize(canvas, pickedId).id,
  };
}

/**
 * The file name of a download. Full size has no size in its name.
 * @param {string} styleId
 * @param {DownloadSize} size
 * @returns {string}
 */
export function downloadFileName(styleId, size) {
  return size.side === null ? `agent-pfp-${styleId}.png` : `agent-pfp-${styleId}-${size.side}.png`;
}

/**
 * What one click on Download saves.
 * @param {{ style: string, canvas: { width: number, height: number } }} manifest
 * @param {unknown} pickedId the value of the Size picker
 * @returns {{ size: DownloadSize, width: number, height: number, fileName: string, scaled: boolean }}
 *   `scaled` is false when the saved picture is the canvas-size picture as it is
 */
export function planDownload(manifest, pickedId) {
  const { canvas } = manifest;
  const size = chooseSize(canvas, pickedId);
  const width = size.side ?? canvas.width;
  const height = size.side ?? canvas.height;
  return {
    size,
    width,
    height,
    fileName: downloadFileName(manifest.style, size),
    scaled: width !== canvas.width || height !== canvas.height,
  };
}

/**
 * The picture to save: the finished canvas-size picture itself when the plan
 * doesn't scale, or a scaled-down copy of it.
 * @param {import('./composite.js').Raster} picture the picture compositeLayers drew
 * @param {{ width: number, height: number, scaled: boolean }} plan from planDownload
 * @returns {import('./composite.js').Raster}
 */
export function pictureToSave(picture, plan) {
  return plan.scaled ? scaleDown(picture, plan.width, plan.height) : picture;
}

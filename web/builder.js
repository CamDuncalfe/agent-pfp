import { validateManifest, groupChoices, resolveSelection, randomSelection } from '../src/manifest.js';

const DEFAULT_MANIFEST = '../fixtures/shapes/manifest.json';
const NONE = '';

const statusEl = document.querySelector('#status');
const styleNameEl = document.querySelector('#style-name');
const controlsEl = document.querySelector('#controls');
const selectionEl = document.querySelector('#selection');
const randomizeEl = document.querySelector('#randomize');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

/** The manifest has to come from this site, so a link cannot point the page at another host. */
function manifestUrl() {
  const requested = new URLSearchParams(location.search).get('manifest') ?? DEFAULT_MANIFEST;
  const url = new URL(requested, location.href);
  if (url.origin !== location.origin) throw new Error('The manifest has to be on this site.');
  return url;
}

async function loadManifest(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the manifest (HTTP ${response.status}).`);
  const manifest = await response.json();
  const result = validateManifest(manifest);
  if (!result.ok) throw new Error(`The manifest is not valid: ${result.errors.join('; ')}`);
  return manifest;
}

function readSelection(manifest) {
  const selection = {};
  for (const group of manifest.groups) {
    const value = controlsEl.elements.namedItem(group.id).value;
    selection[group.id] = value === NONE ? null : value;
  }
  return selection;
}

function writeSelection(manifest, selection) {
  for (const group of manifest.groups) {
    controlsEl.elements.namedItem(group.id).value = selection[group.id] ?? NONE;
  }
}

function buildControls(manifest) {
  controlsEl.replaceChildren();
  for (const group of manifest.groups) {
    const label = document.createElement('label');
    label.append(group.label);
    const select = document.createElement('select');
    select.name = group.id;
    for (const choice of groupChoices(group)) {
      const option = document.createElement('option');
      option.value = choice ?? NONE;
      option.textContent = choice === null ? 'None' : group.options.find((item) => item.id === choice).label;
      select.append(option);
    }
    label.append(select);
    controlsEl.append(label);
  }
}

function showSelection(manifest) {
  const layers = resolveSelection(manifest, readSelection(manifest));
  selectionEl.replaceChildren(
    ...layers.map(({ group, option }) => {
      const item = document.createElement('li');
      item.textContent = `${group.label}: ${option.label} (${option.src})`;
      return item;
    }),
  );
}

async function start() {
  try {
    const manifest = await loadManifest(manifestUrl());
    styleNameEl.textContent = manifest.name;
    buildControls(manifest);
    controlsEl.addEventListener('change', () => showSelection(manifest));
    randomizeEl.addEventListener('click', () => {
      writeSelection(manifest, randomSelection(manifest));
      showSelection(manifest);
    });
    randomizeEl.disabled = false;
    showSelection(manifest);
    setStatus('');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

start();

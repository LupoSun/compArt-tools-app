import { extractLoops, polygonArea, polygonCentroid, pointInPolygon, perimeter, resampleClosed, smoothClosed } from './geometry.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const MAX_WORKING_EDGE = 1600;
const MAX_HISTORY = 14;
const DB_NAME = 'hansketch-shape-extractor';
const DB_STORE = 'projects';
const AUTOSAVE_KEY = 'latest';
const ACCENT = [214, 75, 42];
const AI_RECOGNITION_TIMEOUT = 45_000;
const AI_WORKER_REVISION = 'pose-landmarker-cpu-5';
const ANCHOR_LABELS = {
  body_center: 'Body centre',
  head: 'Head',
  left_hand: 'Left hand',
  right_hand: 'Right hand',
  left_foot: 'Left foot',
  right_foot: 'Right foot',
  custom: 'Custom anchor'
};

const dom = {
  newProject: $('#newProject'), clearAutosave: $('#clearAutosave'), imageInput: $('#imageInput'),
  imageInputSide: $('#imageInputSide'), relinkInput: $('#relinkInput'), projectInput: $('#projectInput'),
  openProject: $('#openProject'), saveProject: $('#saveProject'), sourceMeta: $('#sourceMeta'),
  editorStage: $('#editorStage'), editorCanvas: $('#editorCanvas'), emptyState: $('#emptyState'),
  relinkState: $('#relinkState'), toolHelp: $('#toolHelp'), maskReadout: $('#maskReadout'),
  brushSize: $('#brushSize'), brushSizeOut: $('#brushSizeOut'), undoBtn: $('#undoBtn'), redoBtn: $('#redoBtn'),
  clearMask: $('#clearMask'), suggestionStatus: $('#suggestionStatus'), suggestionText: $('#suggestionText'), recognitionProgress: $('#recognitionProgress'), smoothing: $('#smoothing'), smoothingOut: $('#smoothingOut'),
  targetVertices: $('#targetVertices'), targetVerticesOut: $('#targetVerticesOut'), inflate: $('#inflate'), inflateOut: $('#inflateOut'),
  mergeGaps: $('#mergeGaps'), mergeGapsOut: $('#mergeGapsOut'), randomness: $('#randomness'), randomnessOut: $('#randomnessOut'),
  seed: $('#seed'), allowHoles: $('#allowHoles'), minHoleArea: $('#minHoleArea'), minHoleAreaOut: $('#minHoleAreaOut'),
  variationList: $('#variationList'), anchorKind: $('#anchorKind'), placeAnchor: $('#placeAnchor'), autoAnchors: $('#autoAnchors'), anchorList: $('#anchorList'),
  previewCanvas: $('#previewCanvas'), shapeInfo: $('#shapeInfo'), exportShape: $('#exportShape'), exportSvg: $('#exportSvg'), toast: $('#toast')
};

const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
const editorCtx = dom.editorCanvas.getContext('2d');
const previewCtx = dom.previewCanvas.getContext('2d');

function defaultSettings() {
  return {
    brushSize: 42,
    smoothing: 2,
    targetVertices: 64,
    inflate: 0,
    mergeGaps: 0,
    randomness: 0,
    seed: 'form-01',
    allowHoles: false,
    minHoleArea: 220
  };
}

function emptyProject() {
  return {
    schema: 'hansketch.shape-project',
    version: 1,
    source: null,
    mask: null,
    maskWidth: 0,
    maskHeight: 0,
    settings: defaultSettings(),
    anchors: [],
    shape: null,
    provenance: { selectionMethods: [] }
  };
}

const state = {
  project: emptyProject(),
  sourceImage: null,
  selectedPixels: 0,
  tool: 'add',
  stroke: null,
  history: [],
  redo: [],
  worker: null,
  workerReady: false,
  aiBusy: false,
  suggestionResolved: false,
  suggestionToken: 0,
  recognitionStartedAt: 0,
  recognitionPhase: '',
  recognitionProgress: null,
  recognitionTimer: 0,
  recognitionTimeout: 0,
  detectedPerson: null,
  autosaveTimer: 0,
  shapeTimer: 0,
  renderQueued: false,
  shapeDirty: true,
  awaitingRelink: false,
  toastTimer: 0
};

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', error);
  dom.toast.classList.add('show');
  state.toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 3400);
}

function isLoaded() {
  return Boolean(state.sourceImage && state.project.mask);
}

function getMask() {
  return state.project.mask;
}

function makeSourceMetadata(file, image, workingWidth, workingHeight, fingerprint) {
  return {
    name: file.name,
    type: file.type || 'image/unknown',
    size: file.size,
    lastModified: file.lastModified || null,
    width: image.naturalWidth,
    height: image.naturalHeight,
    workingWidth,
    workingHeight,
    fingerprint,
    relinkRequired: true
  };
}

async function fingerprintFile(file) {
  const prefix = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
  const header = new TextEncoder().encode(`${file.name}|${file.type}|${file.size}|${file.lastModified}|`);
  const combined = new Uint8Array(header.length + prefix.byteLength);
  combined.set(header);
  combined.set(new Uint8Array(prefix), header.length);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', combined);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${file.size}-${file.lastModified}-${file.name}`;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be decoded as an image.'));
    };
    image.src = url;
  });
}

async function openImageFile(file, relink = false) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    showToast('Choose a PNG, JPEG, or WebP image.', true);
    return;
  }
  try {
    const [image, fingerprint] = await Promise.all([loadImageElement(file), fingerprintFile(file)]);
    if (relink && state.project.source?.fingerprint && fingerprint !== state.project.source.fingerprint) {
      const continueRelink = window.confirm('This file does not match the saved image fingerprint. Relink it anyway?');
      if (!continueRelink) return;
      showToast('Image fingerprint differs. Existing mask was retained against the new source.', true);
    }
    const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    sourceCtx.clearRect(0, 0, width, height);
    sourceCtx.drawImage(image, 0, 0, width, height);
    maskCanvas.width = width;
    maskCanvas.height = height;
    dom.editorCanvas.width = width;
    dom.editorCanvas.height = height;
    state.sourceImage = image;
    // Composition mode picks up the same image if it has none of its own.
    window.dispatchEvent(new CustomEvent('shapeextractor:image', { detail: { image, name: file.name } }));

    const retainMask = relink && state.project.mask;
    if (retainMask) {
      if (state.project.maskWidth !== width || state.project.maskHeight !== height) {
        state.project.mask = resizeMaskNearest(state.project.mask, state.project.maskWidth, state.project.maskHeight, width, height);
        state.project.maskWidth = width;
        state.project.maskHeight = height;
        showToast('Mask was resampled to match the relinked working image.');
      }
      state.project.source = { ...state.project.source, ...makeSourceMetadata(file, image, width, height, fingerprint) };
      state.project.shape = null;
    } else {
      clearTimeout(state.shapeTimer);
      state.project = emptyProject();
      state.detectedPerson = null;
      state.project.source = makeSourceMetadata(file, image, width, height, fingerprint);
      state.project.maskWidth = width;
      state.project.maskHeight = height;
      state.project.mask = new Uint8Array(width * height);
    }
    state.selectedPixels = countSelected(state.project.mask);
    state.awaitingRelink = false;
    dom.relinkState.hidden = true;
    dom.emptyState.hidden = true;
    state.history = [];
    state.redo = [];
    state.shapeDirty = true;
    syncUI();
    scheduleRender();
    scheduleAutosave();
    if (relink) {
      setAiWorkerSource(state.suggestionToken);
      scheduleShapeUpdate(0);
      showToast('Reference image relinked.');
    } else {
      requestInitialSuggestion();
      showToast('Image loaded. Looking for a person…');
    }
  } catch (error) {
    showToast(error.message || 'Unable to open the image.', true);
  }
}

function resetProject() {
  clearTimeout(state.shapeTimer);
  state.project = emptyProject();
  state.sourceImage = null;
  state.selectedPixels = 0;
  state.history = [];
  state.redo = [];
  state.shapeDirty = true;
  state.awaitingRelink = false;
  state.detectedPerson = null;
  sourceCanvas.width = sourceCanvas.height = 0;
  maskCanvas.width = maskCanvas.height = 0;
  dom.editorCanvas.width = dom.editorCanvas.height = 300;
  dom.emptyState.hidden = false;
  dom.relinkState.hidden = true;
  resetAiWorker();
  syncUI();
  renderEditor();
  drawPreview();
}

function sourceMetadataText() {
  const source = state.project.source;
  if (!source) return 'No image loaded';
  const sizeMb = source.size ? `${(source.size / 1024 / 1024).toFixed(1)} MB` : 'Saved project source';
  return `${source.name || 'Relinked image'}\n${source.width || '?'} × ${source.height || '?'} px\nWorking: ${source.workingWidth || state.project.maskWidth} × ${source.workingHeight || state.project.maskHeight}\n${sizeMb}`;
}

function syncUI() {
  const settings = state.project.settings;
  dom.sourceMeta.textContent = sourceMetadataText();
  dom.brushSize.value = settings.brushSize;
  dom.brushSizeOut.value = `${settings.brushSize} px`;
  dom.smoothing.value = settings.smoothing;
  dom.smoothingOut.value = settings.smoothing;
  dom.targetVertices.value = settings.targetVertices;
  dom.targetVerticesOut.value = settings.targetVertices;
  dom.inflate.value = settings.inflate;
  dom.inflateOut.value = `${settings.inflate} px`;
  dom.mergeGaps.value = settings.mergeGaps;
  dom.mergeGapsOut.value = settings.mergeGaps ? `${settings.mergeGaps} px` : 'off';
  dom.randomness.value = settings.randomness;
  dom.randomnessOut.value = settings.randomness;
  dom.seed.value = settings.seed;
  dom.allowHoles.checked = settings.allowHoles;
  dom.minHoleArea.value = settings.minHoleArea;
  dom.minHoleAreaOut.value = `${settings.minHoleArea} px²`;
  dom.minHoleArea.closest('.hole-option').classList.toggle('is-disabled', !settings.allowHoles);
  dom.undoBtn.disabled = state.history.length === 0;
  dom.redoBtn.disabled = state.redo.length === 0;
  dom.maskReadout.textContent = `${state.selectedPixels.toLocaleString()} selected pixels`;
  dom.placeAnchor.disabled = !isLoaded() || state.selectedPixels === 0;
  dom.autoAnchors.disabled = !isLoaded() || state.selectedPixels === 0 || !state.detectedPerson?.anchors?.length;
  const placingAnchor = state.tool === 'anchor';
  dom.placeAnchor.classList.toggle('primary', placingAnchor);
  dom.placeAnchor.setAttribute('aria-pressed', placingAnchor ? 'true' : 'false');
  dom.exportShape.disabled = !state.project.shape || state.shapeDirty;
  dom.exportSvg.disabled = !state.project.shape || state.shapeDirty;
  $$('.tool').forEach((button) => {
    const active = button.dataset.tool === state.tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  updateToolHelp();
  renderAnchorList();
  updateShapeInfo();
}

function updateToolHelp() {
  const help = {
    add: 'Add brush: paint the material that should survive abstraction.',
    subtract: 'Subtract brush: remove areas from the current selection.',
    lasso: 'Lasso: draw a closed selection. Hold Option / Alt to subtract.',
    fill: 'Fill region: click a connected selected or unselected region to invert it.',
    anchor: 'Semantic binding: click inside the selected material to place the chosen anchor.'
  };
  dom.toolHelp.textContent = help[state.tool] || help.add;
}

function updateShapeInfo() {
  const shape = state.project.shape;
  if (state.shapeDirty) {
    dom.shapeInfo.textContent = state.selectedPixels ? 'Updating abstract contour…' : 'Open an image to receive a suggested form.';
    return;
  }
  if (!shape) {
    dom.shapeInfo.textContent = state.selectedPixels ? 'The selected material could not form a closed contour.' : 'Open an image to receive a suggested form.';
    return;
  }
  const anchors = state.project.anchors.length;
  const semanticReady = isSemanticReady();
  dom.shapeInfo.textContent = `${shape.outer.points.length} outer vertices\n${shape.holes.length} internal ${shape.holes.length === 1 ? 'hole' : 'holes'}\n${anchors} semantic ${anchors.length === 1 ? 'anchor' : 'anchors'}${semanticReady ? '\nSemantic binding ready' : ''}${shape.warnings?.length ? `\n${shape.warnings.join(' ')}` : ''}`;
}

function renderAnchorList() {
  const anchors = state.project.anchors;
  if (!anchors.length) {
    dom.anchorList.textContent = 'No anchors placed';
    dom.anchorList.classList.add('muted');
    return;
  }
  dom.anchorList.classList.remove('muted');
  dom.anchorList.replaceChildren(...anchors.map((anchor) => {
    const row = document.createElement('div');
    row.className = 'anchor-item';
    const label = document.createElement('span');
    label.textContent = ANCHOR_LABELS[anchor.kind] || anchor.kind;
    label.title = `${anchor.x.toFixed(3)}, ${anchor.y.toFixed(3)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = `Remove ${label.textContent}`;
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      pushHistory('Remove anchor');
      state.project.anchors = state.project.anchors.filter((item) => item.id !== anchor.id);
      scheduleAutosave();
      syncUI();
      scheduleRender();
    });
    row.append(label, remove);
    return row;
  }));
}

function isSemanticReady() {
  return state.project.anchors.some((anchor) => anchor.kind === 'body_center') && state.project.anchors.filter((anchor) => anchor.kind !== 'body_center').length >= 2;
}

function cloneUndoState(label) {
  return {
    label,
    mask: state.project.mask ? state.project.mask.slice() : null,
    anchors: state.project.anchors.map((anchor) => ({ ...anchor }))
  };
}

function pushHistory(label) {
  if (!state.project.mask) return;
  state.history.push(cloneUndoState(label));
  if (state.history.length > MAX_HISTORY) state.history.shift();
  state.redo = [];
  syncUI();
}

function restoreUndoState(snapshot) {
  if (!snapshot) return;
  state.project.mask = snapshot.mask.slice();
  state.project.anchors = snapshot.anchors.map((anchor) => ({ ...anchor }));
  state.selectedPixels = countSelected(state.project.mask);
  state.project.shape = null;
  state.shapeDirty = true;
  scheduleAutosave();
  scheduleShapeUpdate(0);
  syncUI();
  scheduleRender();
  drawPreview();
}

function undo() {
  if (!state.history.length) return;
  state.redo.push(cloneUndoState('Redo'));
  restoreUndoState(state.history.pop());
}

function redo() {
  if (!state.redo.length) return;
  state.history.push(cloneUndoState('Undo'));
  restoreUndoState(state.redo.pop());
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderEditor();
  });
}

function scheduleShapeUpdate(delay = 90) {
  clearTimeout(state.shapeTimer);
  if (!isLoaded() || !state.selectedPixels) {
    state.project.shape = null;
    state.shapeDirty = false;
    drawPreview();
    syncUI();
    return;
  }
  state.shapeTimer = setTimeout(() => refreshShape({ quiet: true }), delay);
}

function renderEditor() {
  const canvas = dom.editorCanvas;
  const width = canvas.width;
  const height = canvas.height;
  editorCtx.clearRect(0, 0, width, height);
  if (!isLoaded()) return;
  editorCtx.drawImage(sourceCanvas, 0, 0);
  updateMaskCanvas();
  editorCtx.drawImage(maskCanvas, 0, 0);
  drawLasso();
  drawAnchors();
}

function updateMaskCanvas() {
  const mask = getMask();
  if (!mask) return;
  const imageData = maskCtx.createImageData(state.project.maskWidth, state.project.maskHeight);
  const pixels = imageData.data;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const offset = index * 4;
    pixels[offset] = ACCENT[0];
    pixels[offset + 1] = ACCENT[1];
    pixels[offset + 2] = ACCENT[2];
    pixels[offset + 3] = 108;
  }
  maskCtx.putImageData(imageData, 0, 0);
}

function drawLasso() {
  const stroke = state.stroke;
  if (!stroke || stroke.type !== 'lasso' || stroke.points.length < 2) return;
  editorCtx.save();
  editorCtx.strokeStyle = '#ffffff';
  editorCtx.fillStyle = 'rgba(36,88,216,.18)';
  editorCtx.lineWidth = Math.max(1, Math.min(state.project.maskWidth, state.project.maskHeight) / 700);
  editorCtx.setLineDash([5, 4]);
  editorCtx.beginPath();
  editorCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
  stroke.points.slice(1).forEach((point) => editorCtx.lineTo(point.x, point.y));
  editorCtx.stroke();
  editorCtx.restore();
}

function drawAnchors() {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const radius = Math.max(4, Math.min(width, height) / 115);
  editorCtx.save();
  editorCtx.font = `${Math.max(10, Math.min(width, height) / 95)}px var(--font)`;
  editorCtx.textBaseline = 'middle';
  state.project.anchors.forEach((anchor) => {
    const x = anchor.x * width;
    const y = anchor.y * height;
    editorCtx.fillStyle = '#2458d8';
    editorCtx.strokeStyle = '#fff';
    editorCtx.lineWidth = Math.max(1.5, radius * .45);
    editorCtx.beginPath();
    editorCtx.arc(x, y, radius, 0, Math.PI * 2);
    editorCtx.fill();
    editorCtx.stroke();
    editorCtx.fillStyle = '#fff';
    editorCtx.strokeStyle = 'rgba(0,0,0,.5)';
    editorCtx.lineWidth = 3;
    const label = ANCHOR_LABELS[anchor.kind] || anchor.kind;
    editorCtx.strokeText(label, x + radius + 4, y);
    editorCtx.fillText(label, x + radius + 4, y);
  });
  editorCtx.restore();
}

function pointerToCanvas(event) {
  const bounds = dom.editorCanvas.getBoundingClientRect();
  return {
    x: clamp(Math.round((event.clientX - bounds.left) * dom.editorCanvas.width / bounds.width), 0, dom.editorCanvas.width - 1),
    y: clamp(Math.round((event.clientY - bounds.top) * dom.editorCanvas.height / bounds.height), 0, dom.editorCanvas.height - 1)
  };
}

function updateMaskPixel(index, value) {
  const mask = getMask();
  if (mask[index] === value) return;
  state.selectedPixels += value ? 1 : -1;
  mask[index] = value;
}

function paintDisk(x, y, radius, value) {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const r = Math.max(1, Math.round(radius));
  const left = Math.max(0, x - r);
  const right = Math.min(width - 1, x + r);
  const top = Math.max(0, y - r);
  const bottom = Math.min(height - 1, y + r);
  const radiusSq = r * r;
  for (let py = top; py <= bottom; py += 1) {
    const dy = py - y;
    for (let px = left; px <= right; px += 1) {
      const dx = px - x;
      if (dx * dx + dy * dy <= radiusSq) updateMaskPixel(py * width + px, value);
    }
  }
}

function paintSegment(from, to, radius, value) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * .35)));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    paintDisk(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t), radius, value);
  }
}

function floodFill(x, y) {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const mask = getMask();
  const start = y * width + x;
  const wanted = mask[start];
  const next = wanted ? 0 : 1;
  const queue = new Int32Array(mask.length);
  const visited = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  visited[start] = 1;
  while (head < tail) {
    const index = queue[head++];
    updateMaskPixel(index, next);
    const px = index % width;
    const py = (index / width) | 0;
    if (px > 0) enqueueIfSame(index - 1);
    if (px < width - 1) enqueueIfSame(index + 1);
    if (py > 0) enqueueIfSame(index - width);
    if (py < height - 1) enqueueIfSame(index + width);
  }
  function enqueueIfSame(index) {
    if (!visited[index] && mask[index] === wanted) {
      visited[index] = 1;
      queue[tail++] = index;
    }
  }
}

function applyLasso(points, value) {
  if (points.length < 3) return;
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const minX = clamp(Math.floor(Math.min(...points.map((point) => point.x))), 0, width - 1);
  const maxX = clamp(Math.ceil(Math.max(...points.map((point) => point.x))), 0, width - 1);
  const minY = clamp(Math.floor(Math.min(...points.map((point) => point.y))), 0, height - 1);
  const maxY = clamp(Math.ceil(Math.max(...points.map((point) => point.y))), 0, height - 1);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (pointInPolygon({ x: x + .5, y: y + .5 }, points)) updateMaskPixel(y * width + x, value);
    }
  }
}

function placeAnchor(point) {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const index = point.y * width + point.x;
  if (!getMask()[index]) {
    showToast('Place anchors inside the selected material.', true);
    return;
  }
  const kind = dom.anchorKind.value;
  pushHistory('Place anchor');
  const anchor = { id: `${kind}-${Date.now().toString(36)}`, kind, x: point.x / width, y: point.y / height };
  if (kind !== 'custom') {
    const existing = state.project.anchors.findIndex((item) => item.kind === kind);
    if (existing >= 0) state.project.anchors.splice(existing, 1, anchor);
    else state.project.anchors.push(anchor);
  } else {
    state.project.anchors.push(anchor);
  }
  scheduleAutosave();
  syncUI();
  scheduleRender();
}

function nearestMaskPoint(x, y) {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const mask = getMask();
  const originX = clamp(Math.round(x * (width - 1)), 0, width - 1);
  const originY = clamp(Math.round(y * (height - 1)), 0, height - 1);
  if (mask[originY * width + originX]) return { x: originX / width, y: originY / height };
  const limit = Math.max(8, Math.round(Math.min(width, height) * .08));
  for (let radius = 1; radius <= limit; radius += 1) {
    const minX = Math.max(0, originX - radius);
    const maxX = Math.min(width - 1, originX + radius);
    const minY = Math.max(0, originY - radius);
    const maxY = Math.min(height - 1, originY + radius);
    for (let px = minX; px <= maxX; px += 1) {
      if (mask[minY * width + px]) return { x: px / width, y: minY / height };
      if (mask[maxY * width + px]) return { x: px / width, y: maxY / height };
    }
    for (let py = minY + 1; py < maxY; py += 1) {
      if (mask[py * width + minX]) return { x: minX / width, y: py / height };
      if (mask[py * width + maxX]) return { x: maxX / width, y: py / height };
    }
  }
  return null;
}

function placeDetectedAnchors() {
  const candidates = state.detectedPerson?.anchors || [];
  const anchors = candidates.map((candidate) => {
    const snapped = nearestMaskPoint(candidate.x, candidate.y);
    return snapped ? { ...candidate, ...snapped } : null;
  }).filter(Boolean);
  if (!anchors.length) {
    showToast('Detected landmarks do not intersect the current person mask.', true);
    return;
  }
  pushHistory('Place detected anchors');
  anchors.forEach((candidate) => {
    const index = state.project.anchors.findIndex((anchor) => anchor.kind === candidate.kind);
    const anchor = {
      id: index >= 0 ? state.project.anchors[index].id : `${candidate.kind}-${Date.now().toString(36)}`,
      kind: candidate.kind,
      x: candidate.x,
      y: candidate.y
    };
    if (index >= 0) state.project.anchors.splice(index, 1, anchor);
    else state.project.anchors.push(anchor);
  });
  scheduleAutosave();
  syncUI();
  scheduleRender();
  showToast(`${anchors.length} detected anchors placed. Drag any one to refine it.`);
}

function anchorAt(point) {
  const width = state.project.maskWidth;
  const height = state.project.maskHeight;
  const radius = Math.max(10, Math.min(width, height) / 55);
  let closest = null;
  let closestDistance = radius * radius;
  state.project.anchors.forEach((anchor) => {
    const dx = anchor.x * width - point.x;
    const dy = anchor.y * height - point.y;
    const distance = dx * dx + dy * dy;
    if (distance <= closestDistance) {
      closest = anchor;
      closestDistance = distance;
    }
  });
  return closest;
}

function moveAnchor(anchorId, point) {
  const anchor = state.project.anchors.find((item) => item.id === anchorId);
  if (!anchor) return;
  anchor.x = clamp(point.x / state.project.maskWidth, 0, 1);
  anchor.y = clamp(point.y / state.project.maskHeight, 0, 1);
}

function markMaskChanged(method = 'manual', refreshUI = true) {
  if (!state.project.provenance.selectionMethods.includes(method)) state.project.provenance.selectionMethods.push(method);
  state.shapeDirty = true;
  scheduleAutosave();
  scheduleShapeUpdate();
  if (refreshUI) {
    syncUI();
    drawPreview();
  }
}

function onPointerDown(event) {
  if (!isLoaded() || state.aiBusy) return;
  const point = pointerToCanvas(event);
  const existingAnchor = anchorAt(point);
  if (existingAnchor) {
    pushHistory('Move anchor');
    state.stroke = { type: 'anchor-drag', anchorId: existingAnchor.id };
    dom.editorCanvas.setPointerCapture(event.pointerId);
    dom.editorCanvas.style.cursor = 'grabbing';
    moveAnchor(existingAnchor.id, point);
    scheduleRender();
    return;
  }
  const tool = state.tool;
  if (tool === 'anchor') {
    placeAnchor(point);
    return;
  }
  if (tool === 'fill') {
    pushHistory('Fill region');
    floodFill(point.x, point.y);
    markMaskChanged('manual-fill');
    scheduleRender();
    return;
  }
  if (tool === 'lasso') {
    pushHistory('Lasso mask');
    state.stroke = { type: 'lasso', points: [point], subtract: event.altKey };
    dom.editorCanvas.setPointerCapture(event.pointerId);
    scheduleRender();
    return;
  }
  pushHistory(tool === 'subtract' ? 'Subtract brush' : 'Add brush');
  const value = tool === 'subtract' ? 0 : 1;
  state.stroke = { type: 'brush', value, last: point };
  dom.editorCanvas.setPointerCapture(event.pointerId);
  paintDisk(point.x, point.y, state.project.settings.brushSize / 2, value);
  markMaskChanged('manual-brush', false);
  scheduleRender();
}

function onPointerMove(event) {
  const stroke = state.stroke;
  if (!isLoaded()) return;
  const point = pointerToCanvas(event);
  if (!stroke) {
    dom.editorCanvas.style.cursor = anchorAt(point) ? 'grab' : 'crosshair';
    return;
  }
  if (stroke.type === 'brush') {
    paintSegment(stroke.last, point, state.project.settings.brushSize / 2, stroke.value);
    stroke.last = point;
    markMaskChanged('manual-brush', false);
  } else if (stroke.type === 'lasso') {
    const previous = stroke.points[stroke.points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 2) stroke.points.push(point);
  } else if (stroke.type === 'anchor-drag') {
    moveAnchor(stroke.anchorId, point);
  }
  scheduleRender();
}

function onPointerEnd(event) {
  const stroke = state.stroke;
  if (!stroke) return;
  if (stroke.type === 'lasso') {
    applyLasso(stroke.points, stroke.subtract ? 0 : 1);
    markMaskChanged('manual-lasso');
  } else if (stroke.type === 'brush') {
    markMaskChanged('manual-brush');
  } else if (stroke.type === 'anchor-drag') {
    scheduleAutosave();
  }
  state.stroke = null;
  dom.editorCanvas.style.cursor = 'crosshair';
  if (dom.editorCanvas.hasPointerCapture(event.pointerId)) dom.editorCanvas.releasePointerCapture(event.pointerId);
  syncUI();
  scheduleRender();
}

function setTool(tool) {
  state.tool = tool;
  syncUI();
  scheduleRender();
}

function setSetting(key, value) {
  state.project.settings[key] = value;
  state.shapeDirty = true;
  scheduleAutosave();
  scheduleShapeUpdate();
  syncUI();
  drawPreview();
}

// ---------------------- Mask processing ----------------------

function countSelected(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) count += mask[index] ? 1 : 0;
  return count;
}

function resizeMaskNearest(source, sourceWidth, sourceHeight, width, height) {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
      output[y * width + x] = source[sy * sourceWidth + sx];
    }
  }
  return output;
}

function closeGaps(source, width, height, amount) {
  let current = source.slice();
  for (let step = 0; step < amount; step += 1) {
    const next = new Uint8Array(current.length);
    for (let index = 0; index < current.length; index += 1) {
      const x = index % width;
      const y = (index / width) | 0;
      next[index] = current[index] || (x > 0 && current[index - 1]) || (x < width - 1 && current[index + 1]) || (y > 0 && current[index - width]) || (y < height - 1 && current[index + width]) ? 1 : 0;
    }
    current = next;
  }
  for (let step = 0; step < amount; step += 1) {
    const next = new Uint8Array(current.length);
    for (let index = 0; index < current.length; index += 1) {
      const x = index % width;
      const y = (index / width) | 0;
      next[index] = current[index] && x > 0 && x < width - 1 && y > 0 && y < height - 1 && current[index - 1] && current[index + 1] && current[index - width] && current[index + width] ? 1 : 0;
    }
    current = next;
  }
  return current;
}

function keepLargestForeground(source, width, height) {
  const visited = new Uint8Array(source.length);
  const queue = new Int32Array(source.length);
  let largestStart = -1;
  let largestSize = 0;
  for (let start = 0; start < source.length; start += 1) {
    if (!source[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    const enqueue = (index) => {
      if (source[index] && !visited[index]) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      if (x > 0) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
      if (y > 0) enqueue(index - width);
      if (y < height - 1) enqueue(index + width);
    }
    if (tail > largestSize) {
      largestStart = start;
      largestSize = tail;
    }
  }
  if (largestStart < 0) return new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  let head = 0;
  let tail = 0;
  const enqueueOutput = (index) => {
    if (source[index] && !output[index]) {
      output[index] = 1;
      queue[tail++] = index;
    }
  };
  queue[tail++] = largestStart;
  output[largestStart] = 1;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index / width) | 0;
    if (x > 0) enqueueOutput(index - 1);
    if (x < width - 1) enqueueOutput(index + 1);
    if (y > 0) enqueueOutput(index - width);
    if (y < height - 1) enqueueOutput(index + width);
  }
  return output;
}

function processHoles(mask, width, height, allowHoles, minArea) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let kept = 0;
  let filled = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    const enqueue = (index) => {
      if (!mask[index] && !visited[index]) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x > 0) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
      if (y > 0) enqueue(index - width);
      if (y < height - 1) enqueue(index + width);
    }
    const isHole = !touchesBorder;
    const shouldFill = isHole && (!allowHoles || tail < minArea);
    if (shouldFill) {
      for (let position = 0; position < tail; position += 1) mask[queue[position]] = 1;
      filled += 1;
    } else if (isHole) {
      kept += 1;
    }
  }
  return { kept, filled };
}

function seededRandom(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash += 0x6D2B79F5;
    let value = hash;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function transformRing(points, settings, index, width, height) {
  let transformed = points.map((point) => ({ ...point }));
  if (!settings.inflate && !settings.randomness) return { ring: transformed, rejected: false };
  if (settings.inflate) transformed = offsetRing(transformed, settings.inflate);
  if (settings.randomness) {
    const random = seededRandom(`${settings.seed}-${index}`);
    let values = transformed.map(() => random() * 2 - 1);
    for (let round = 0; round < 3; round += 1) values = values.map((value, pointIndex) => (values[(pointIndex - 1 + values.length) % values.length] + value * 2 + values[(pointIndex + 1) % values.length]) / 4);
    const centroid = polygonCentroid(transformed);
    transformed = transformed.map((point, pointIndex) => {
      const previous = transformed[(pointIndex - 1 + transformed.length) % transformed.length];
      const next = transformed[(pointIndex + 1) % transformed.length];
      let nx = -(next.y - previous.y);
      let ny = next.x - previous.x;
      const length = Math.hypot(nx, ny) || 1;
      nx /= length;
      ny /= length;
      if (nx * (point.x - centroid.x) + ny * (point.y - centroid.y) < 0) {
        nx *= -1;
        ny *= -1;
      }
      const amount = values[pointIndex] * settings.randomness;
      return { x: point.x + nx * amount, y: point.y + ny * amount };
    });
  }
  if (ringEscapesBounds(transformed, width, height) || selfIntersects(transformed)) return { ring: points.map((point) => ({ ...point })), rejected: true };
  return { ring: transformed, rejected: false };
}

function offsetRing(points, amount) {
  const centroid = polygonCentroid(points);
  return points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    let nx = -(next.y - previous.y);
    let ny = next.x - previous.x;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;
    if (nx * (point.x - centroid.x) + ny * (point.y - centroid.y) < 0) {
      nx *= -1;
      ny *= -1;
    }
    return { x: point.x + nx * amount, y: point.y + ny * amount };
  });
}

function ringEscapesBounds(points, width, height) {
  return points.some((point) => point.x <= 0 || point.y <= 0 || point.x >= width || point.y >= height);
}

function selfIntersects(points) {
  for (let a = 0; a < points.length; a += 1) {
    const a2 = (a + 1) % points.length;
    for (let b = a + 1; b < points.length; b += 1) {
      const b2 = (b + 1) % points.length;
      if (a === b || a2 === b || b2 === a || (a === 0 && b2 === 0)) continue;
      if (segmentsIntersect(points[a], points[a2], points[b], points[b2])) return true;
    }
  }
  return false;
}

function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function ringsIntersect(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    for (let other = 0; other < b.length; other += 1) {
      if (segmentsIntersect(a[index], a[(index + 1) % a.length], b[other], b[(other + 1) % b.length])) return true;
    }
  }
  return false;
}

function normalizeRing(points, width, height, id) {
  return {
    id,
    closed: true,
    points: points.map((point, index) => ({
      id: `${id}-${index}`,
      x: clamp(point.x / width, 0, 1),
      y: clamp(point.y / height, 0, 1)
    }))
  };
}

function refreshShape({ quiet = false } = {}) {
  if (!isLoaded() || !state.selectedPixels) {
    if (!quiet) showToast('Paint some material before extracting a form.', true);
    return false;
  }
  const { maskWidth: width, maskHeight: height, settings } = state.project;
  let working = getMask().slice();
  if (settings.mergeGaps) working = closeGaps(working, width, height, settings.mergeGaps);
  working = keepLargestForeground(working, width, height);
  const holeResult = processHoles(working, width, height, settings.allowHoles, settings.minHoleArea);
  const loops = extractLoops(working, width, height);
  if (!loops.length) {
    state.project.shape = null;
    state.shapeDirty = false;
    drawPreview();
    syncUI();
    if (!quiet) showToast('The current mask did not produce a closed contour.', true);
    return false;
  }
  const outerRaw = loops.reduce((largest, loop) => Math.abs(polygonArea(loop)) > Math.abs(polygonArea(largest)) ? loop : largest, loops[0]);
  const holeRaw = loops.filter((loop) => loop !== outerRaw && pointInPolygon(polygonCentroid(loop), outerRaw));
  const outerBase = smoothClosed(resampleClosed(outerRaw, settings.targetVertices), settings.smoothing);
  const outerTransform = transformRing(outerBase, settings, 0, width, height);
  const warnings = [];
  if (outerTransform.rejected) warnings.push('Outer transformation was clamped to avoid self-intersection.');
  const outer = outerTransform.ring;
  const outerLength = perimeter(outerRaw) || 1;
  const holes = [];
  holeRaw.forEach((raw, index) => {
    const target = clamp(Math.round(settings.targetVertices * perimeter(raw) / outerLength), 12, 128);
    const base = smoothClosed(resampleClosed(raw, target), settings.smoothing);
    const transformed = transformRing(base, settings, index + 1, width, height);
    const ring = transformed.ring;
    const safe = !transformed.rejected && ring.every((point) => pointInPolygon(point, outer)) && !ringsIntersect(outer, ring) && !holes.some((existing) => ringsIntersect(existing, ring));
    if (safe) holes.push(ring);
    else warnings.push('One internal hole was omitted after abstraction to keep a closed border.');
  });
  state.project.shape = {
    schema: 'hansketch.shape',
    version: 1,
    coordinateSpace: 'normalized-image-space (origin: top-left, x/y: 0..1)',
    outer: normalizeRing(outer, width, height, 'outer'),
    holes: holes.map((ring, index) => normalizeRing(ring, width, height, `hole-${index}`)),
    warnings,
    extraction: {
      selectedPixels: state.selectedPixels,
      generatedAt: new Date().toISOString(),
      holesDetected: holeResult.kept,
      holesFilled: holeResult.filled
    }
  };
  state.shapeDirty = false;
  drawPreview();
  syncUI();
  scheduleAutosave();
  if (!quiet) showToast(`Abstract form updated with ${state.project.shape.holes.length} ${state.project.shape.holes.length === 1 ? 'hole' : 'holes'}.`);
  return true;
}

function drawPreview() {
  const ctx = previewCtx;
  const canvas = dom.previewCanvas;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const shape = state.project.shape;
  if (!shape) {
    ctx.fillStyle = '#8b8577';
    ctx.font = '13px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Abstract contour preview', canvas.width / 2, canvas.height / 2 - 8);
    ctx.font = '11px Helvetica, Arial, sans-serif';
    ctx.fillText('The contour will appear automatically.', canvas.width / 2, canvas.height / 2 + 14);
    return;
  }
  const padding = 28;
  const scaleX = canvas.width - padding * 2;
  const scaleY = canvas.height - padding * 2;
  ctx.save();
  ctx.beginPath();
  drawNormalizedRingPath(ctx, shape.outer.points, padding, padding, scaleX, scaleY);
  shape.holes.forEach((hole) => drawNormalizedRingPath(ctx, hole.points, padding, padding, scaleX, scaleY));
  ctx.fillStyle = 'rgba(214,75,42,.84)';
  ctx.fill('evenodd');
  ctx.strokeStyle = '#1a1a17';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  shape.holes.forEach((hole) => {
    ctx.beginPath();
    drawNormalizedRingPath(ctx, hole.points, padding, padding, scaleX, scaleY);
    ctx.stroke();
  });
  ctx.fillStyle = '#2458d8';
  state.project.anchors.forEach((anchor) => {
    ctx.beginPath();
    ctx.arc(padding + anchor.x * scaleX, padding + anchor.y * scaleY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawNormalizedRingPath(ctx, vertices, offsetX, offsetY, scaleX, scaleY) {
  if (!vertices.length) return;
  ctx.moveTo(offsetX + vertices[0].x * scaleX, offsetY + vertices[0].y * scaleY);
  vertices.slice(1).forEach((point) => ctx.lineTo(offsetX + point.x * scaleX, offsetY + point.y * scaleY));
  ctx.closePath();
}

// ---------------------- AI helper ----------------------

function setSuggestionStatus(text, recognising = false) {
  dom.suggestionText.textContent = text;
  dom.suggestionStatus.classList.toggle('is-recognising', recognising);
  dom.suggestionStatus.setAttribute('aria-busy', recognising ? 'true' : 'false');
  dom.recognitionProgress.setAttribute('aria-hidden', recognising ? 'false' : 'true');
}

function recognitionElapsedText() {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.recognitionStartedAt) / 1000));
  return `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
}

function renderRecognitionProgress() {
  if (!state.aiBusy || !state.recognitionStartedAt) return;
  const elapsed = recognitionElapsedText();
  const percentage = state.recognitionProgress === null ? '' : ` ${state.recognitionProgress}%`;
  setSuggestionStatus(`AI person recognition is running — ${state.recognitionPhase}${percentage} (${elapsed})`, true);
  dom.suggestionStatus.classList.toggle('is-determinate-recognising', state.recognitionProgress !== null);
  dom.recognitionProgress.setAttribute('aria-valuetext', `${state.recognitionPhase}${percentage}. Elapsed time ${elapsed}.`);
  if (state.recognitionProgress !== null) {
    dom.recognitionProgress.style.setProperty('--recognition-progress', `${state.recognitionProgress}%`);
    dom.recognitionProgress.setAttribute('aria-valuenow', String(state.recognitionProgress));
  }
}

function startRecognitionProgress() {
  stopRecognitionProgress();
  state.recognitionStartedAt = Date.now();
  state.recognitionPhase = 'Preparing the model…';
  state.recognitionProgress = null;
  renderRecognitionProgress();
  state.recognitionTimer = window.setInterval(renderRecognitionProgress, 1000);
}

function updateRecognitionProgress(phase) {
  state.recognitionPhase = phase || 'Looking for a person…';
  if (!state.recognitionPhase.startsWith('Downloading')) state.recognitionProgress = null;
  renderRecognitionProgress();
}

function updateRecognitionDownloadProgress(loaded, total) {
  if (!total || !state.aiBusy) return;
  state.recognitionProgress = clamp(Math.round(loaded / total * 100), 0, 100);
  renderRecognitionProgress();
}

function stopRecognitionProgress() {
  clearInterval(state.recognitionTimer);
  clearTimeout(state.recognitionTimeout);
  state.recognitionTimer = 0;
  state.recognitionTimeout = 0;
  state.recognitionStartedAt = 0;
  state.recognitionPhase = '';
  state.recognitionProgress = null;
  dom.suggestionStatus.classList.remove('is-determinate-recognising');
  dom.recognitionProgress.style.removeProperty('--recognition-progress');
  dom.recognitionProgress.removeAttribute('aria-valuenow');
}

function resetAiWorker() {
  stopRecognitionProgress();
  state.suggestionToken += 1;
  if (state.worker) state.worker.terminate();
  state.worker = null;
  state.workerReady = false;
  state.aiBusy = false;
  state.suggestionResolved = false;
  setSuggestionStatus('Opening an image looks for a person. If none is recognised, use the mask tools to define the material.');
}

function initializeAiWorker() {
  if (!isLoaded() || !window.Worker) return false;
  if (state.worker) return true;
  try {
    state.worker = new Worker(`./ai-worker.js?rev=${AI_WORKER_REVISION}`);
    state.worker.addEventListener('message', onAiMessage);
    state.worker.addEventListener('error', () => {
      state.workerReady = false;
      finishNoPersonSuggestion('Person recognition is unavailable here. Use the mask tools to define the material.');
    });
    return true;
  } catch {
    return false;
  }
}

async function setAiWorkerSource(token) {
  if (!state.worker || !isLoaded() || !globalThis.createImageBitmap) return false;
  const bitmap = await createImageBitmap(sourceCanvas);
  if (!state.worker || token !== state.suggestionToken) {
    bitmap.close();
    return false;
  }
  state.worker.postMessage({ type: 'source', token, width: state.project.maskWidth, height: state.project.maskHeight, bitmap }, [bitmap]);
  return true;
}

async function requestInitialSuggestion() {
  const token = ++state.suggestionToken;
  state.suggestionResolved = false;
  state.detectedPerson = null;
  state.aiBusy = true;
  startRecognitionProgress();
  if (window.location.protocol === 'file:') {
    finishNoPersonSuggestion('Person recognition needs a local web server. Open this tool through http://localhost:8000, then try again.');
    return;
  }
  if (!initializeAiWorker()) {
    finishNoPersonSuggestion('Person recognition is unavailable here. Use the mask tools to define the material.');
    return;
  }
  try {
    state.recognitionTimeout = window.setTimeout(() => {
      if (token !== state.suggestionToken || state.suggestionResolved) return;
      if (state.worker) state.worker.terminate();
      state.worker = null;
      state.workerReady = false;
      finishNoPersonSuggestion('Person recognition did not finish within 45 seconds. Check your connection, then try again or use the mask tools.');
    }, AI_RECOGNITION_TIMEOUT);
    if (!await setAiWorkerSource(token) || token !== state.suggestionToken) return;
    state.worker.postMessage({ type: 'suggest', token });
  } catch {
    finishNoPersonSuggestion('Person recognition could not start. Use the mask tools to define the material.');
  }
}

function onAiMessage(event) {
  const message = event.data || {};
  if (message.type === 'ready') {
    state.workerReady = Boolean(message.poseLandmarker);
    return;
  }
  if (message.type === 'status') {
    if (!state.suggestionResolved) updateRecognitionProgress(message.text);
    return;
  }
  if (message.type === 'progress') {
    if (!state.suggestionResolved) updateRecognitionDownloadProgress(message.loaded, message.total);
    return;
  }
  if (message.type === 'result') {
    if (message.token !== state.suggestionToken || !isLoaded() || message.width !== state.project.maskWidth || message.height !== state.project.maskHeight) return;
    applyInitialSuggestion(new Uint8Array(message.mask), message.anchors || []);
    return;
  }
  if (message.type === 'no-person' && message.token === state.suggestionToken) finishNoPersonSuggestion(message.text);
  if (message.type === 'error' && message.token === state.suggestionToken) finishNoPersonSuggestion(message.text || 'Person recognition could not finish. Use the mask tools to define the material.');
}

function applyInitialSuggestion(result, anchors) {
  if (state.suggestionResolved || !isLoaded()) return;
  state.suggestionResolved = true;
  state.aiBusy = false;
  stopRecognitionProgress();
  const mask = getMask();
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    const value = result[index] > 0 ? 1 : 0;
    mask[index] = value;
    count += value;
  }
  state.selectedPixels = count;
  if (!count) {
    state.detectedPerson = null;
    state.project.shape = null;
    state.shapeDirty = false;
    setSuggestionStatus('No usable person mask was found. Use the mask tools to define the material.');
    showToast('No usable person mask was found. Start with the Add brush.', true);
    syncUI();
    drawPreview();
    scheduleRender();
    return;
  }
  state.detectedPerson = { anchors };
  markMaskChanged('ai-person-pose-landmarker');
  setSuggestionStatus('Person mask suggested. Refine it with the mask tools, then place or drag semantic anchors.');
  showToast('Person mask and landmarks are ready to refine.');
  scheduleRender();
}

function finishNoPersonSuggestion(text = 'No person was recognised. Use the mask tools to define the material.') {
  if (state.suggestionResolved || !isLoaded()) return;
  state.suggestionResolved = true;
  state.aiBusy = false;
  stopRecognitionProgress();
  state.detectedPerson = null;
  state.project.mask.fill(0);
  state.selectedPixels = 0;
  state.project.shape = null;
  state.shapeDirty = false;
  setSuggestionStatus(text);
  showToast('No person recognised. Start with the Add brush.', true);
  syncUI();
  drawPreview();
  scheduleRender();
}

// ---------------------- Project persistence ----------------------

function encodeMask(mask) {
  if (!mask) return null;
  const values = [];
  let current = mask[0] || 0;
  let length = 1;
  for (let index = 1; index < mask.length; index += 1) {
    if (mask[index] === current && length < 0xffffffff) length += 1;
    else {
      values.push(length, current);
      current = mask[index];
      length = 1;
    }
  }
  values.push(length, current);
  const words = new Uint32Array(values);
  const bytes = new Uint8Array(words.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

function decodeMask(encoded, length) {
  if (!encoded) return new Uint8Array(length);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const words = new Uint32Array(bytes.buffer);
  const output = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < words.length; index += 2) {
    const run = words[index];
    const value = words[index + 1];
    output.fill(value, offset, Math.min(output.length, offset + run));
    offset += run;
    if (offset >= output.length) break;
  }
  return output;
}

function projectSerializable() {
  return {
    schema: 'hansketch.shape-project',
    version: 1,
    savedAt: new Date().toISOString(),
    source: state.project.source ? { ...state.project.source, relinkRequired: true } : null,
    mask: state.project.mask ? { encoding: 'rle-u32-base64', data: encodeMask(state.project.mask) } : null,
    maskWidth: state.project.maskWidth,
    maskHeight: state.project.maskHeight,
    settings: { ...state.project.settings },
    anchors: state.project.anchors.map((anchor) => ({ ...anchor })),
    shape: state.project.shape ? JSON.parse(JSON.stringify(state.project.shape)) : null,
    provenance: JSON.parse(JSON.stringify(state.project.provenance || { selectionMethods: [] }))
  };
}

function importProject(data) {
  if (!data || data.schema !== 'hansketch.shape-project' || Number(data.version) !== 1) throw new Error('This is not a supported Shape Extractor Project JSON file.');
  const width = Number(data.maskWidth);
  const height = Number(data.maskHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_WORKING_EDGE * MAX_WORKING_EDGE) throw new Error('The project mask dimensions are invalid.');
  const mask = decodeMask(data.mask?.data, width * height);
  state.project = {
    schema: 'hansketch.shape-project',
    version: 1,
    source: data.source || null,
    mask,
    maskWidth: width,
    maskHeight: height,
    settings: { ...defaultSettings(), ...(data.settings || {}) },
    anchors: Array.isArray(data.anchors) ? data.anchors.map((anchor) => ({ ...anchor })) : [],
    shape: data.shape || null,
    provenance: data.provenance || { selectionMethods: [] }
  };
  state.sourceImage = null;
  state.selectedPixels = countSelected(mask);
  state.history = [];
  state.redo = [];
  state.shapeDirty = !state.project.shape;
  state.awaitingRelink = true;
  dom.editorCanvas.width = width;
  dom.editorCanvas.height = height;
  sourceCanvas.width = sourceCanvas.height = 0;
  maskCanvas.width = width;
  maskCanvas.height = height;
  dom.emptyState.hidden = true;
  dom.relinkState.hidden = false;
  resetAiWorker();
  syncUI();
  drawPreview();
  showToast('Project loaded. Relink its image before editing the mask.');
}

async function openProjectFile(file) {
  if (!file) return;
  try {
    importProject(JSON.parse(await file.text()));
    scheduleAutosave();
  } catch (error) {
    showToast(error.message || 'Unable to open project JSON.', true);
  }
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function saveProject() {
  download('shape-extractor-project.json', JSON.stringify(projectSerializable(), null, 2), 'application/json');
  showToast('Shape Extractor project saved. Source pixels are not embedded.');
}

function shapeExport() {
  if (!state.project.shape) return null;
  return {
    schema: 'hansketch.shape',
    version: 1,
    exportedAt: new Date().toISOString(),
    coordinateSystem: 'normalized-image-space (origin top-left, x/y 0..1)',
    source: state.project.source ? {
      name: state.project.source.name,
      width: state.project.source.width,
      height: state.project.source.height,
      workingWidth: state.project.maskWidth,
      workingHeight: state.project.maskHeight,
      fingerprint: state.project.source.fingerprint,
      relinkRequired: true
    } : null,
    provenance: {
      selectionMethods: state.project.provenance.selectionMethods || [],
      sourceImageEmbedded: false,
      model: (state.project.provenance.selectionMethods || []).includes('ai-person-pose-landmarker') ? { name: 'MediaPipe Pose Landmarker Full', packageVersion: '0.10.35', modelVersion: '1', outputSegmentationMasks: true } : null
    },
    abstraction: {
      smoothing: state.project.settings.smoothing,
      targetVertices: state.project.settings.targetVertices,
      inflate: state.project.settings.inflate,
      mergeGaps: state.project.settings.mergeGaps,
      randomness: state.project.settings.randomness,
      seed: state.project.settings.seed,
      allowInternalHoles: state.project.settings.allowHoles,
      minimumHoleArea: state.project.settings.minHoleArea
    },
    shape: {
      outer: state.project.shape.outer,
      holes: state.project.shape.holes,
      anchors: state.project.anchors.map((anchor) => ({
        id: anchor.id,
        name: anchor.kind,
        label: ANCHOR_LABELS[anchor.kind] || anchor.kind,
        x: anchor.x,
        y: anchor.y
      }))
    },
    anchors: state.project.anchors.map((anchor) => ({
      id: anchor.id,
      name: anchor.kind,
      label: ANCHOR_LABELS[anchor.kind] || anchor.kind,
      x: anchor.x,
      y: anchor.y
    })),
    validation: {
      semanticBindingReady: isSemanticReady(),
      warnings: state.project.shape.warnings || []
    }
  };
}

function exportShape() {
  if (state.shapeDirty || !state.project.shape) refreshShape();
  const data = shapeExport();
  if (!data) return;
  const base = (state.project.source?.name || 'shape').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  download(`${base}-abstract-shape.json`, JSON.stringify(data, null, 2), 'application/json');
  showToast('Shape JSON exported.');
}

function exportSvg() {
  if (state.shapeDirty || !state.project.shape) refreshShape();
  const shape = state.project.shape;
  if (!shape || !state.project.source) return;
  const width = state.project.source.width || state.project.maskWidth;
  const height = state.project.source.height || state.project.maskHeight;
  const path = [shape.outer, ...shape.holes].map((ring) => `${ring.points.map((point, index) => `${index ? 'L' : 'M'}${(point.x * width).toFixed(2)} ${(point.y * height).toFixed(2)}`).join(' ')} Z`).join(' ');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <path d="${path}" fill="#d64b2a" fill-rule="evenodd" stroke="#1a1a17" stroke-width="2"/>\n</svg>\n`;
  const base = (state.project.source.name || 'shape').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  download(`${base}-abstract-contour.svg`, svg, 'image/svg+xml');
  showToast('Contour SVG exported.');
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function dbPut(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function dbDelete(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(async () => {
    try {
      await dbPut(AUTOSAVE_KEY, projectSerializable());
    } catch {
      // IndexedDB can be disabled in private contexts. The working project remains usable.
    }
  }, 650);
}

async function restoreAutosave() {
  try {
    const saved = await dbGet(AUTOSAVE_KEY);
    if (saved?.source || saved?.mask) importProject(saved);
  } catch {
    // No autosave is a normal first-run condition.
  }
}

// ---------------------- Event binding ----------------------

dom.imageInput.addEventListener('change', (event) => openImageFile(event.target.files[0]));
dom.imageInputSide.addEventListener('change', (event) => openImageFile(event.target.files[0]));
dom.relinkInput.addEventListener('change', (event) => openImageFile(event.target.files[0], true));
dom.projectInput.addEventListener('change', (event) => openProjectFile(event.target.files[0]));
dom.openProject.addEventListener('click', () => dom.projectInput.click());
dom.saveProject.addEventListener('click', saveProject);
dom.newProject.addEventListener('click', () => {
  if (state.project.source || state.selectedPixels || state.project.shape) {
    if (!window.confirm('Start a new Shape Extractor project? The current project remains in browser autosave until this empty project is saved.')) return;
  }
  resetProject();
  scheduleAutosave();
  showToast('New empty project started.');
});
dom.clearAutosave.addEventListener('click', async () => {
  if (!window.confirm('Clear only the Shape Extractor browser autosave? The current open project and cached model files stay untouched.')) return;
  try {
    await dbDelete(AUTOSAVE_KEY);
    showToast('Browser autosave cleared.');
  } catch {
    showToast('Unable to clear browser autosave.', true);
  }
});
dom.undoBtn.addEventListener('click', undo);
dom.redoBtn.addEventListener('click', redo);
dom.clearMask.addEventListener('click', () => {
  if (!isLoaded() || !state.selectedPixels) return;
  if (!window.confirm('Clear the current selection mask?')) return;
  pushHistory('Clear mask');
  state.project.mask.fill(0);
  state.selectedPixels = 0;
  markMaskChanged('manual-clear');
  scheduleRender();
});
$$('.tool').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
dom.brushSize.addEventListener('input', () => setSetting('brushSize', Number(dom.brushSize.value)));
dom.smoothing.addEventListener('input', () => setSetting('smoothing', Number(dom.smoothing.value)));
dom.targetVertices.addEventListener('input', () => setSetting('targetVertices', Number(dom.targetVertices.value)));
dom.inflate.addEventListener('input', () => setSetting('inflate', Number(dom.inflate.value)));
dom.mergeGaps.addEventListener('input', () => setSetting('mergeGaps', Number(dom.mergeGaps.value)));
dom.randomness.addEventListener('input', () => setSetting('randomness', Number(dom.randomness.value)));
dom.seed.addEventListener('change', () => setSetting('seed', dom.seed.value.trim() || 'form-01'));
dom.allowHoles.addEventListener('change', () => setSetting('allowHoles', dom.allowHoles.checked));
dom.minHoleArea.addEventListener('input', () => setSetting('minHoleArea', Number(dom.minHoleArea.value)));
dom.placeAnchor.addEventListener('click', () => setTool('anchor'));
dom.autoAnchors.addEventListener('click', placeDetectedAnchors);
dom.variationList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-variation]');
  if (!button) return;
  const base = (dom.seed.value.trim() || 'form').replace(/-\d+$/, '');
  setSetting('seed', `${base}-${button.dataset.variation}`);
});
dom.exportShape.addEventListener('click', exportShape);
dom.exportSvg.addEventListener('click', exportSvg);
dom.editorCanvas.addEventListener('pointerdown', onPointerDown);
dom.editorCanvas.addEventListener('pointermove', onPointerMove);
dom.editorCanvas.addEventListener('pointerup', onPointerEnd);
dom.editorCanvas.addEventListener('pointercancel', onPointerEnd);
dom.editorCanvas.addEventListener('lostpointercapture', (event) => {
  if (state.stroke) onPointerEnd(event);
});
['dragenter', 'dragover'].forEach((type) => dom.editorStage.addEventListener(type, (event) => {
  event.preventDefault();
  dom.editorStage.classList.add('drag-over');
}));
['dragleave', 'drop'].forEach((type) => dom.editorStage.addEventListener(type, (event) => {
  event.preventDefault();
  dom.editorStage.classList.remove('drag-over');
}));
dom.editorStage.addEventListener('drop', (event) => openImageFile(event.dataTransfer.files[0], state.awaitingRelink));
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
  }
  if (event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
  }
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

syncUI();
drawPreview();
restoreAutosave();

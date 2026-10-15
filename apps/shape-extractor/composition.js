// Composition mode: digitise a flat-colour artwork — a print, a collage, a
// painted relief photographed head-on — into several coloured forms stacked on
// planes, and export them as an SVG that HanSketch's File ▸ Import SVG turns into
// layers (one per plane), keeping colours and positions.
//
// Pipeline: soften texture → reduce to a few colours (k-means in Lab) → merge
// near-identical colours → clean speckle → connected regions → dissolve specks
// and thin anti-aliasing seams back into their neighbours → merge neighbouring
// regions split by uneven light (a soft border, not an edge) → background = the
// region holding most of the image border → each other region becomes a form,
// its holes filled, stacked one plane above whatever surrounds it.
//
// Everything runs locally; the image is never stored or uploaded.

import { extractLoops, polygonArea, perimeter, resampleClosed, smoothClosed, pointInPolygon } from './geometry.js';

const WORK_EDGE = 720;              // analysis resolution (long edge, px)
const THIN_RATIO = 1.5;             // area / boundary below this = a seam, not a form
const SETTINGS_KEY = 'hansketch-shape-extractor.composition';
const MODE_KEY = 'hansketch-shape-extractor.mode';

const DEFAULTS = {
  colours: 6,       // k-means clusters before merging
  merge: 14,        // merge colours closer than this (ΔE, CIE76)
  texture: 2,       // blur radius in working px before clustering
  minArea: 0.15,    // forms smaller than this % of the image are dissolved
  dropEdge: true,   // leave out forms cut by the image edge (book edges, frames)
  smoothing: 2,     // contour smoothing rounds
  detail: 6         // outline point spacing in working px
};

const $ = (selector) => document.querySelector(selector);

const ui = {
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  single: $('#singleWorkspace'),
  composition: $('#compositionWorkspace'),
  topNav: $('.topbar nav'),
  subtitle: $('.topbar .subtitle'),
  imageInput: $('#compImageInput'),
  meta: $('#compSourceMeta'),
  stage: $('#compStage'),
  canvas: $('#compCanvas'),
  empty: $('#compEmpty'),
  status: $('#compStatus'),
  readout: $('#compReadout'),
  preview: $('#compPreview'),
  info: $('#compInfo'),
  list: $('#compFormList'),
  exportSvg: $('#compExportSvg'),
  send: $('#compSendBtn'),
  reset: $('#compReset'),
  toast: $('#toast')
};

const controls = {
  colours: { input: $('#compColours'), out: $('#compColoursOut'), fmt: v => `${v}` },
  merge: { input: $('#compMerge'), out: $('#compMergeOut'), fmt: v => v ? `ΔE ${v}` : 'off' },
  texture: { input: $('#compTexture'), out: $('#compTextureOut'), fmt: v => v ? `${v} px` : 'off' },
  minArea: { input: $('#compMinArea'), out: $('#compMinAreaOut'), fmt: v => `${(+v).toFixed(2)} %` },
  smoothing: { input: $('#compSmoothing'), out: $('#compSmoothingOut'), fmt: v => `${v}` },
  detail: { input: $('#compDetail'), out: $('#compDetailOut'), fmt: v => `${v} px` }
};
const dropEdgeInput = $('#compDropEdge');

const comp = {
  settings: loadSettings(),
  image: null,
  name: '',
  width: 0,
  height: 0,
  rgba: null,
  result: null,
  include: new Map(),
  hover: null,
  timer: 0,
  toastTimer: 0
};

const workCanvas = document.createElement('canvas');
const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
const stageCtx = ui.canvas.getContext('2d');
const previewCtx = ui.preview.getContext('2d');

// ---------------------------------------------------------------- settings

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(comp.settings)); } catch { /* private mode */ }
}

function syncControls() {
  for (const [key, control] of Object.entries(controls)) {
    control.input.value = comp.settings[key];
    control.out.value = control.fmt(comp.settings[key]);
  }
  dropEdgeInput.checked = comp.settings.dropEdge;
}

function toast(message, error = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', error);
  ui.toast.classList.add('show');
  clearTimeout(comp.toastTimer);
  comp.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- mode switch

function setMode(mode) {
  const composition = mode === 'composition';
  ui.single.hidden = composition;
  ui.composition.hidden = !composition;
  // The project buttons belong to the single-form workflow.
  ui.topNav.hidden = composition;
  ui.subtitle.textContent = composition ? 'artwork → coloured forms' : 'image → abstract boundary';
  ui.modeButtons.forEach(button => {
    const on = button.dataset.mode === mode;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  if (composition) {
    renderStage();
    renderPreview();
  }
}

// ---------------------------------------------------------------- image in

function loadImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    toast('Choose a PNG, JPEG, or WebP image.', true);
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(url);
    useImage(image, file.name);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    toast('This file could not be decoded as an image.', true);
  };
  image.src = url;
}

function useImage(image, name) {
  comp.image = image;
  comp.name = name || 'artwork';
  const scale = Math.min(1, WORK_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  comp.width = Math.max(1, Math.round(image.naturalWidth * scale));
  comp.height = Math.max(1, Math.round(image.naturalHeight * scale));
  workCanvas.width = comp.width;
  workCanvas.height = comp.height;
  workCtx.drawImage(image, 0, 0, comp.width, comp.height);
  comp.rgba = workCtx.getImageData(0, 0, comp.width, comp.height).data;
  ui.canvas.width = comp.width;
  ui.canvas.height = comp.height;
  ui.empty.hidden = true;
  ui.meta.textContent = `${comp.name}\n${image.naturalWidth} × ${image.naturalHeight} px\nAnalysed at ${comp.width} × ${comp.height}`;
  analyseSoon(0);
}

// ---------------------------------------------------------------- analysis

function analyseSoon(delay = 220) {
  if (!comp.rgba) return;
  clearTimeout(comp.timer);
  ui.status.textContent = 'Analysing…';
  // A frame first, so the status shows before the main thread is busy.
  comp.timer = setTimeout(() => requestAnimationFrame(() => {
    const started = performance.now();
    try {
      comp.result = analyse(comp.rgba, comp.width, comp.height, comp.settings);
      comp.include = new Map(comp.result.forms.map(form => [form.id, form.includeByDefault]));
      ui.status.textContent = `Analysed in ${Math.round(performance.now() - started)} ms. Click a form on the image or in the list to leave it out or bring it back.`;
    } catch (error) {
      console.error(error);
      comp.result = null;
      ui.status.textContent = 'This image could not be analysed.';
    }
    renderAll();
  }), delay);
}

function analyse(rgba, width, height, settings) {
  const n = width * height;
  const rgb = blurRGB(rgba, width, height, Math.round(settings.texture));
  const lab = toLab(rgb, n);

  // 1. A few colours. Deterministic seed: the same image gives the same forms.
  const random = mulberry32(0xA2B0);
  let centres = kmeans(lab, n, Math.max(2, Math.round(settings.colours)), random);
  let labels = assign(lab, n, centres);
  ({ centres, labels } = mergeCentres(centres, labels, lab, n, settings.merge));
  labels = modeFilter(labels, width, height, 2, centres.length);

  // 2. Regions, with specks and seams dissolved back into their neighbours.
  const minPixels = Math.max(12, Math.round(n * settings.minArea / 100));
  let regions = connectedRegions(labels, width, height);
  regrowOver(regions, width, height, minPixels);
  // Borders are judged on a barely softened copy: the texture blur above would
  // flatten a real edge into a gradient too.
  const edgeLab = toLab(blurRGB(rgba, width, height, 1, 1), n);
  mergeSoftBorders(regions, edgeLab, width, height, settings.merge);
  regions = summariseRegions(regions.id, labels, rgba, width, height);

  // 3. Background: the region that holds most of the image border.
  let background = 0;
  regions.list.forEach(region => {
    if (region.borderPixels > regions.list[background].borderPixels) background = region.index;
  });

  // 4. Forms: outline (holes filled), parent region, colour.
  const forms = [];
  const parents = new Int32Array(regions.list.length).fill(-1);
  regions.list.forEach(region => {
    if (region.index === background || region.area < minPixels) return;
    const traced = traceRegion(regions.id, region, width, height, background);
    parents[region.index] = traced.parent;
    if (!traced.outline) return;
    const length = perimeter(traced.outline);
    const count = Math.max(16, Math.min(720, Math.round(length / Math.max(2, settings.detail))));
    const points = smoothClosed(resampleClosed(traced.outline, count), Math.round(settings.smoothing));
    forms.push({
      id: `form-${region.index}`,
      region: region.index,
      colour: region.colour,
      area: region.area,
      areaPct: region.area / n * 100,
      touchesEdge: region.borderPixels > 0,
      includeByDefault: !(settings.dropEdge && region.borderPixels > 0),
      points
    });
  });

  // 5. Depth: one plane above the region that surrounds it.
  const depthMemo = new Map([[background, 0]]);
  const depthOf = (index, guard = 0) => {
    if (depthMemo.has(index)) return depthMemo.get(index);
    const parent = parents[index];
    const depth = (parent < 0 || guard > 64) ? 1 : depthOf(parent, guard + 1) + 1;
    depthMemo.set(index, depth);
    return depth;
  };
  forms.forEach(form => { form.depth = depthOf(form.region); });
  forms.sort((a, b) => (a.depth - b.depth) || (b.area - a.area));

  return {
    width,
    height,
    background: regions.list[background].colour,
    colourCount: centres.length,
    forms
  };
}

// Separable box blur, applied twice (≈ Gaussian). Softens print screens, paper
// grain and JPEG noise so a flat colour clusters as one.
function blurRGB(rgba, width, height, radius, passes = 2) {
  const n = width * height;
  let channels = [0, 1, 2].map(c => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = rgba[i * 4 + c];
    return out;
  });
  if (radius > 0) {
    for (let pass = 0; pass < passes; pass += 1) {
      channels = channels.map(ch => boxBlur(boxBlur(ch, width, height, radius, true), width, height, radius, false));
    }
  }
  return channels;
}

function boxBlur(src, width, height, r, horizontal) {
  const out = new Float32Array(src.length);
  const lines = horizontal ? height : width;
  const len = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  for (let line = 0; line < lines; line += 1) {
    const base = horizontal ? line * width : line;
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
    for (let i = 0; i < len; i += 1) {
      out[base + i * stride] = sum / (2 * r + 1);
      const add = Math.min(len - 1, i + r + 1);
      const remove = Math.max(0, i - r);
      sum += src[base + add * stride] - src[base + remove * stride];
    }
  }
  return out;
}

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

function toLab([R, G, B], n) {
  const lab = new Float32Array(n * 3);
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < n; i += 1) {
    const r = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(R[i])))];
    const g = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(G[i])))];
    const b = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(B[i])))];
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
    const z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
    lab[i * 3] = 116 * y - 16;
    lab[i * 3 + 1] = 500 * (x - y);
    lab[i * 3 + 2] = 200 * (y - z);
  }
  return lab;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist2(lab, i, c) {
  const dl = lab[i * 3] - c[0], da = lab[i * 3 + 1] - c[1], db = lab[i * 3 + 2] - c[2];
  return dl * dl + da * da + db * db;
}

// k-means++ on a sample of pixels.
function kmeans(lab, n, k, random) {
  const sampleCount = Math.min(n, 24000);
  const sample = new Int32Array(sampleCount);
  const step = n / sampleCount;
  for (let s = 0; s < sampleCount; s += 1) sample[s] = Math.min(n - 1, Math.floor(s * step + random() * step));

  const centres = [];
  const first = sample[Math.floor(random() * sampleCount)];
  centres.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
  const best = new Float64Array(sampleCount).fill(Infinity);
  while (centres.length < k) {
    let total = 0;
    const last = centres[centres.length - 1];
    for (let s = 0; s < sampleCount; s += 1) {
      const d = dist2(lab, sample[s], last);
      if (d < best[s]) best[s] = d;
      total += best[s];
    }
    if (total <= 0) break;
    let pick = random() * total;
    let chosen = sample[sampleCount - 1];
    for (let s = 0; s < sampleCount; s += 1) {
      pick -= best[s];
      if (pick <= 0) { chosen = sample[s]; break; }
    }
    centres.push([lab[chosen * 3], lab[chosen * 3 + 1], lab[chosen * 3 + 2]]);
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let s = 0; s < sampleCount; s += 1) {
      const i = sample[s];
      let bestK = 0, bestD = Infinity;
      for (let c = 0; c < centres.length; c += 1) {
        const d = dist2(lab, i, centres[c]);
        if (d < bestD) { bestD = d; bestK = c; }
      }
      const sum = sums[bestK];
      sum[0] += lab[i * 3]; sum[1] += lab[i * 3 + 1]; sum[2] += lab[i * 3 + 2]; sum[3] += 1;
    }
    let shift = 0;
    centres.forEach((centre, c) => {
      const sum = sums[c];
      if (!sum[3]) return;
      const next = [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
      shift = Math.max(shift, Math.hypot(next[0] - centre[0], next[1] - centre[1], next[2] - centre[2]));
      centres[c] = next;
    });
    if (shift < 0.3) break;
  }
  return centres;
}

function assign(lab, n, centres) {
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    let bestK = 0, bestD = Infinity;
    for (let c = 0; c < centres.length; c += 1) {
      const d = dist2(lab, i, centres[c]);
      if (d < bestD) { bestD = d; bestK = c; }
    }
    labels[i] = bestK;
  }
  return labels;
}

// Merge clusters closer than `threshold` (ΔE). Lighting gradients and texture
// split one painted colour into shades; this puts them back together.
function mergeCentres(centres, labels, lab, n, threshold) {
  const counts = new Float64Array(centres.length);
  for (let i = 0; i < n; i += 1) counts[labels[i]] += 1;
  let groups = centres.map((centre, index) => ({ centre: centre.slice(), count: counts[index], members: [index] }))
    .filter(group => group.count > 0);
  while (threshold > 0 && groups.length > 1) {
    let a = -1, b = -1, closest = Infinity;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const p = groups[i].centre, q = groups[j].centre;
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < closest) { closest = d; a = i; b = j; }
      }
    }
    if (closest >= threshold) break;
    const ga = groups[a], gb = groups[b], total = ga.count + gb.count;
    ga.centre = ga.centre.map((v, k) => (v * ga.count + gb.centre[k] * gb.count) / total);
    ga.count = total;
    ga.members.push(...gb.members);
    groups.splice(b, 1);
  }
  const remap = new Uint8Array(centres.length);
  groups.forEach((group, index) => group.members.forEach(member => { remap[member] = index; }));
  const merged = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) merged[i] = remap[labels[i]];
  return { centres: groups.map(group => group.centre), labels: merged };
}

// Majority vote in a (2r+1)² window: removes salt-and-pepper speckle.
function modeFilter(labels, width, height, r, k) {
  const out = new Uint8Array(labels.length);
  const counts = new Int32Array(k);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      counts.fill(0);
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          counts[labels[yy * width + xx]] += 1;
        }
      }
      let bestK = labels[y * width + x], bestC = counts[bestK];
      for (let c = 0; c < k; c += 1) if (counts[c] > bestC) { bestC = counts[c]; bestK = c; }
      out[y * width + x] = bestK;
    }
  }
  return out;
}

// 4-connected regions of equal colour label.
function connectedRegions(labels, width, height) {
  const n = width * height;
  const id = new Int32Array(n).fill(-1);
  const area = [];
  const stack = new Int32Array(n);
  let count = 0;
  for (let start = 0; start < n; start += 1) {
    if (id[start] !== -1) continue;
    const label = labels[start];
    let top = 0, size = 0;
    stack[top++] = start;
    id[start] = count;
    while (top) {
      const i = stack[--top];
      size += 1;
      const x = i % width;
      if (x > 0 && id[i - 1] === -1 && labels[i - 1] === label) { id[i - 1] = count; stack[top++] = i - 1; }
      if (x < width - 1 && id[i + 1] === -1 && labels[i + 1] === label) { id[i + 1] = count; stack[top++] = i + 1; }
      if (i >= width && id[i - width] === -1 && labels[i - width] === label) { id[i - width] = count; stack[top++] = i - width; }
      if (i < n - width && id[i + width] === -1 && labels[i + width] === label) { id[i + width] = count; stack[top++] = i + width; }
    }
    area.push(size);
    count += 1;
  }
  return { id, area, count };
}

// Dissolve regions that are too small (specks, signatures, stains) or too thin
// (the anti-aliased seam where two colours meet, a pencil line) and let their
// neighbours grow back over them at equal speed, so borders meet in the middle.
function regrowOver(regions, width, height, minPixels) {
  const { id, area, count } = regions;
  const n = width * height;
  const boundary = new Float64Array(count);
  for (let i = 0; i < n; i += 1) {
    const x = i % width;
    if (x < width - 1 && id[i] !== id[i + 1]) { boundary[id[i]] += 1; boundary[id[i + 1]] += 1; }
    if (i < n - width && id[i] !== id[i + width]) { boundary[id[i]] += 1; boundary[id[i + width]] += 1; }
  }
  const dissolve = new Uint8Array(count);
  let largest = 0;
  for (let r = 0; r < count; r += 1) {
    if (area[r] > area[largest]) largest = r;
    if (area[r] < minPixels || (boundary[r] > 0 && area[r] / boundary[r] < THIN_RATIO)) dissolve[r] = 1;
  }
  dissolve[largest] = 0; // something must remain to grow from

  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i += 1) {
    if (dissolve[id[i]]) id[i] = -1;
  }
  for (let i = 0; i < n; i += 1) {
    if (id[i] === -1) continue;
    const x = i % width;
    if ((x > 0 && id[i - 1] === -1) || (x < width - 1 && id[i + 1] === -1) ||
        (i >= width && id[i - width] === -1) || (i < n - width && id[i + width] === -1)) {
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const owner = id[i];
    const x = i % width;
    if (x > 0 && id[i - 1] === -1) { id[i - 1] = owner; queue[tail++] = i - 1; }
    if (x < width - 1 && id[i + 1] === -1) { id[i + 1] = owner; queue[tail++] = i + 1; }
    if (i >= width && id[i - width] === -1) { id[i - width] = owner; queue[tail++] = i - width; }
    if (i < n - width && id[i + width] === -1) { id[i + width] = owner; queue[tail++] = i + width; }
  }
}

// A photograph lit unevenly splits one painted colour into a light and a dark
// region; so does a mottled print. Their colours can differ more than two
// genuinely different paints, so colour distance alone cannot tell them apart.
// The border can: a real edge is a jump in colour, a lighting split is a slow
// gradient. Neighbours are merged when they are nearly the same colour
// (`threshold`) or when their border is a slope rather than a step.
// Two numbers per shared border, averaged along it: the colour step right at
// the border (`near`, the two touching pixels) and the difference BORDER_REACH
// pixels out on either side (`far`). A painted edge is a step, so near is a
// fair part of far; uneven light is a slope, so far keeps growing while near
// stays small. The ratio separates them where colour distance cannot. Measured
// on a photographed book page: painted edges near/far 0.22–0.26 — including a
// navy circle on teal only ~21 ΔE apart — and the light falling off where the
// page curves 0.11–0.12, although its two yellows are ~28 ΔE apart.
const BORDER_REACH = 5;
const SOFT_BORDER_RATIO = 0.17;
function mergeSoftBorders(regions, lab, width, height, threshold) {
  if (!(threshold > 0)) return;
  const { id, count } = regions;
  const n = width * height;
  const stats = new Map(); // pair key -> [sum near, sum far, samples]
  const de = (a, b) => Math.hypot(lab[a * 3] - lab[b * 3], lab[a * 3 + 1] - lab[b * 3 + 1], lab[a * 3 + 2] - lab[b * 3 + 2]);
  // Walk outward from a border pixel while staying inside its own region.
  const reach = (start, step, limit) => {
    let at = start;
    for (let k = 0; k < limit; k += 1) {
      const next = at + step;
      if (next < 0 || next >= n || id[next] !== id[start]) break;
      if (step === 1 && next % width === 0) break;
      if (step === -1 && at % width === 0) break;
      at = next;
    }
    return at;
  };
  const sample = (i, j, step) => {
    const a = reach(i, -step, BORDER_REACH), b = reach(j, step, BORDER_REACH);
    if (a === i || b === j) return; // too thin to judge here
    const ri = id[i], rj = id[j];
    const key = ri < rj ? ri * count + rj : rj * count + ri;
    const entry = stats.get(key) || [0, 0, 0];
    entry[0] += de(i, j); entry[1] += de(a, b); entry[2] += 1;
    stats.set(key, entry);
  };
  for (let i = 0; i < n; i += 1) {
    if (i % width < width - 1 && id[i] !== id[i + 1]) sample(i, i + 1, 1);
    if (i < n - width && id[i] !== id[i + width]) sample(i, i + width, width);
  }
  const parent = new Int32Array(count).map((_, k) => k);
  const find = k => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  // Long borders only: a few soft pixels where two forms barely touch are not
  // evidence that they are one.
  stats.forEach(([near, far, samples], key) => {
    if (samples < 24) return;
    near /= samples; far /= samples;
    const sameColour = far < threshold;
    const gradient = far > 0 && near / far < SOFT_BORDER_RATIO;
    if (!sameColour && !gradient) return;
    const a = find(Math.floor(key / count)), b = find(key % count);
    if (a !== b) parent[b] = a;
  });
  for (let i = 0; i < n; i += 1) id[i] = find(id[i]);
}

// Area, bounding box, border contact and colour per surviving region.
function summariseRegions(idIn, labels, rgba, width, height) {
  const n = width * height;
  const renumber = new Map();
  const id = new Int32Array(n);
  const list = [];
  for (let i = 0; i < n; i += 1) {
    let r = renumber.get(idIn[i]);
    if (r === undefined) {
      r = list.length;
      renumber.set(idIn[i], r);
      list.push({ index: r, area: 0, borderPixels: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1,
        labelCounts: new Map(), sums: new Map() });
    }
    id[i] = r;
    const region = list[r];
    const x = i % width, y = (i / width) | 0;
    region.area += 1;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) region.borderPixels += 1;
    if (x < region.x0) region.x0 = x;
    if (x > region.x1) region.x1 = x;
    if (y < region.y0) region.y0 = y;
    if (y > region.y1) region.y1 = y;
    const label = labels[i];
    region.labelCounts.set(label, (region.labelCounts.get(label) || 0) + 1);
    let sum = region.sums.get(label);
    if (!sum) { sum = [0, 0, 0]; region.sums.set(label, sum); }
    sum[0] += rgba[i * 4]; sum[1] += rgba[i * 4 + 1]; sum[2] += rgba[i * 4 + 2];
  }
  list.forEach(region => {
    // Clusters holding at least 15% of the region (all of a light/dark pair
    // merged above); a stain or speck absorbed into the region stays out.
    const total = [0, 0, 0];
    let pixels = 0;
    region.labelCounts.forEach((count, key) => {
      if (count < region.area * 0.15) return;
      const sum = region.sums.get(key);
      total[0] += sum[0]; total[1] += sum[1]; total[2] += sum[2];
      pixels += count;
    });
    if (!pixels) {
      region.labelCounts.forEach((count, key) => {
        const sum = region.sums.get(key);
        total[0] += sum[0]; total[1] += sum[1]; total[2] += sum[2];
        pixels += count;
      });
    }
    region.colour = hex(total[0] / pixels, total[1] / pixels, total[2] / pixels);
    delete region.labelCounts;
    delete region.sums;
  });
  return { id, list };
}

function hex(r, g, b) {
  const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Outline of one region with its holes filled, plus the region that surrounds
// it: whatever lies just outside its outer edge (the image border counts as
// background).
function traceRegion(id, region, width, height, background) {
  const x0 = region.x0 - 1, y0 = region.y0 - 1;
  const w = region.x1 - region.x0 + 3, h = region.y1 - region.y0 + 3;
  const own = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      if (id[(y0 + y) * width + (x0 + x)] === region.index) own[y * w + x] = 1;
    }
  }
  // Flood the outside from the padded frame; whatever it cannot reach is a hole.
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  for (let x = 0; x < w; x += 1) { outside[x] = 1; stack[top++] = x; outside[(h - 1) * w + x] = 1; stack[top++] = (h - 1) * w + x; }
  for (let y = 1; y < h - 1; y += 1) { outside[y * w] = 1; stack[top++] = y * w; outside[y * w + w - 1] = 1; stack[top++] = y * w + w - 1; }
  const tally = new Map();
  while (top) {
    const i = stack[--top];
    const x = i % w, y = (i / w) | 0;
    const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    let touches = false;
    for (const j of neighbours) {
      if (j < 0) continue;
      if (own[j]) { touches = true; continue; }
      if (!outside[j]) { outside[j] = 1; stack[top++] = j; }
    }
    if (touches) {
      const gx = x0 + x, gy = y0 + y;
      const owner = (gx < 0 || gy < 0 || gx >= width || gy >= height) ? background : id[gy * width + gx];
      tally.set(owner, (tally.get(owner) || 0) + 1);
    }
  }
  let parent = background, most = -1;
  tally.forEach((count, owner) => { if (owner !== region.index && count > most) { most = count; parent = owner; } });

  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) filled[i] = outside[i] ? 0 : 1;
  const loops = extractLoops(filled, w, h);
  if (!loops.length) return { outline: null, parent };
  const outer = loops.reduce((a, b) => (Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a));
  return { outline: outer.map(p => ({ x: p.x + x0, y: p.y + y0 })), parent };
}

// ---------------------------------------------------------------- planes

// Planes are numbered over the forms that are actually included, bottom first.
function planeNumbers() {
  const result = comp.result;
  if (!result) return new Map();
  const depths = [...new Set(result.forms.filter(f => comp.include.get(f.id)).map(f => f.depth))].sort((a, b) => a - b);
  return new Map(depths.map((depth, index) => [depth, index + 1]));
}

// ---------------------------------------------------------------- rendering

function tracePath(ctx, points, scale = 1, ox = 0, oy = 0) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * scale, oy + p.y * scale) : ctx.moveTo(ox + p.x * scale, oy + p.y * scale)));
  ctx.closePath();
}

function renderStage() {
  const ctx = stageCtx;
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  if (!comp.image) return;
  ctx.drawImage(workCanvas, 0, 0);
  const result = comp.result;
  if (!result) return;
  ctx.fillStyle = 'rgba(245,242,234,.55)';
  ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);
  const line = Math.max(1, Math.min(comp.width, comp.height) / 360);
  result.forms.forEach(form => {
    const on = comp.include.get(form.id);
    tracePath(ctx, form.points);
    if (on) {
      ctx.fillStyle = form.colour;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash(on ? [] : [line * 4, line * 3]);
    ctx.lineWidth = form.id === comp.hover ? line * 3 : line;
    ctx.strokeStyle = form.id === comp.hover ? '#d64b2a' : (on ? '#1a1a17' : '#807b70');
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function renderPreview() {
  const ctx = previewCtx;
  const cw = ui.preview.width, ch = ui.preview.height;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, cw, ch);
  const result = comp.result;
  if (!result) {
    ctx.fillStyle = '#8b8577';
    ctx.font = '13px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('The digitised composition', cw / 2, ch / 2 - 8);
    ctx.font = '11px Helvetica, Arial, sans-serif';
    ctx.fillText('appears here after analysis.', cw / 2, ch / 2 + 12);
    return;
  }
  const pad = 14;
  const scale = Math.min((cw - pad * 2) / result.width, (ch - pad * 2) / result.height);
  const ox = (cw - result.width * scale) / 2, oy = (ch - result.height * scale) / 2;
  ctx.fillStyle = result.background;
  ctx.fillRect(ox, oy, result.width * scale, result.height * scale);
  result.forms.forEach(form => {
    if (!comp.include.get(form.id)) return;
    tracePath(ctx, form.points, scale, ox, oy);
    ctx.fillStyle = form.colour;
    ctx.fill();
  });
}

function renderList() {
  const result = comp.result;
  ui.list.textContent = '';
  if (!result) {
    ui.info.textContent = comp.image ? 'Analysing…' : 'Open an artwork to digitise its forms.';
    ui.exportSvg.disabled = true;
    ui.send.disabled = true;
    ui.readout.textContent = '';
    return;
  }
  const planes = planeNumbers();
  const included = result.forms.filter(f => comp.include.get(f.id));
  ui.info.textContent = `${included.length} of ${result.forms.length} forms on ${planes.size} plane${planes.size === 1 ? '' : 's'}\n`
    + `${result.colourCount} colour${result.colourCount === 1 ? '' : 's'} · background ${result.background}`;
  ui.readout.textContent = `${included.length} forms · ${planes.size} planes`;
  ui.exportSvg.disabled = included.length === 0;
  ui.send.disabled = included.length === 0;
  result.forms.forEach(form => {
    const row = document.createElement('label');
    row.className = 'comp-form';
    row.classList.toggle('is-off', !comp.include.get(form.id));
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!comp.include.get(form.id);
    check.addEventListener('change', () => {
      comp.include.set(form.id, check.checked);
      renderAll();
    });
    const swatch = document.createElement('span');
    swatch.className = 'comp-swatch';
    swatch.style.background = form.colour;
    const text = document.createElement('span');
    text.className = 'comp-form-text';
    const plane = planes.get(form.depth);
    text.textContent = `${plane ? `Plane ${plane}` : 'Left out'} · ${form.areaPct < 0.1 ? form.areaPct.toFixed(2) : form.areaPct.toFixed(1)} %${form.touchesEdge ? ' · edge' : ''}`;
    row.append(check, swatch, text);
    row.addEventListener('pointerenter', () => { comp.hover = form.id; renderStage(); });
    row.addEventListener('pointerleave', () => { comp.hover = null; renderStage(); });
    ui.list.appendChild(row);
  });
}

function renderAll() {
  renderStage();
  renderPreview();
  renderList();
}

// ---------------------------------------------------------------- stage clicks

function stagePoint(event) {
  const bounds = ui.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * ui.canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * ui.canvas.height / bounds.height
  };
}

// The topmost form under the pointer: highest plane, then smallest.
function formAt(point) {
  const result = comp.result;
  if (!result) return null;
  let hit = null;
  result.forms.forEach(form => {
    if (!pointInPolygon(point, form.points)) return;
    if (!hit || form.depth > hit.depth || (form.depth === hit.depth && form.area < hit.area)) hit = form;
  });
  return hit;
}

// ---------------------------------------------------------------- export

function compositionSvg() {
  const result = comp.result;
  const planes = planeNumbers();
  const scale = 1000 / Math.max(result.width, result.height);
  const vw = Math.round(result.width * scale), vh = Math.round(result.height * scale);
  const fmt = v => (Math.round(v * scale * 10) / 10).toString();
  const groups = new Map();
  result.forms.forEach(form => {
    if (!comp.include.get(form.id)) return;
    const plane = planes.get(form.depth);
    const d = form.points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join(' ') + ' Z';
    if (!groups.has(plane)) groups.set(plane, []);
    groups.get(plane).push(`    <path d="${d}" fill="${form.colour}"/>`);
  });
  const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" data-hansketch-composition="1">`,
    `  <title>${escape(comp.name.replace(/\.[^.]+$/, ''))}: composition</title>`,
    '  <desc>Digitised with Shape Extractor (Composition). One group per plane, bottom first. Open in HanSketch with File ▸ Import SVG.</desc>',
    `  <rect data-hansketch="background" x="0" y="0" width="${vw}" height="${vh}" fill="${result.background}"/>`
  ];
  [...groups.keys()].sort((a, b) => a - b).forEach(plane => {
    lines.push(`  <g id="Plane_${plane}" data-name="Plane ${plane}">`, ...groups.get(plane), '  </g>');
  });
  lines.push('</svg>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- hand-off to HanSketch
// Both apps are served from one origin — locally and in the public mirror — so
// the composition can travel through the browser instead of a downloaded file.
// It is left in a shared inbox in localStorage and announced on a
// BroadcastChannel; an open HanSketch tab takes it at once, otherwise a new
// HanSketch tab finds it on start-up. The document is the same composition SVG
// as the download (contracts/composition-svg.md).
const INBOX_KEY = 'hansketch.inbox';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('hansketch') : null;
let hansketchSeenAt = 0;   // last time an open HanSketch tab answered
let hansketchWindow = null; // the tab this page opened, if any

channel?.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'hansketch-here') hansketchSeenAt = Date.now();
  if (message.type === 'inbox-taken' && message.id === comp.sentId) {
    toast('HanSketch has the composition — switch to its tab to place it.');
  }
});
const pingHanSketch = () => channel?.postMessage({ type: 'who-is-hansketch' });
pingHanSketch();
setInterval(() => { if (!document.hidden) pingHanSketch(); }, 3000);

function sendToHanSketch() {
  if (!comp.result) return;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    schema: 'hansketch.inbox',
    version: 1,
    kind: 'composition-svg',
    id,
    name: comp.name.replace(/\.[^.]+$/, '') || 'artwork',
    sentAt: new Date().toISOString(),
    svg: compositionSvg()
  };
  try {
    localStorage.setItem(INBOX_KEY, JSON.stringify(payload));
  } catch {
    toast('The browser would not hold the composition. Use Download SVG instead.', true);
    return;
  }
  comp.sentId = id;
  channel?.postMessage({ type: 'inbox', id });
  // Synchronous with the click, so the new tab is not treated as a pop-up.
  // A HanSketch tab this page opened, or the one that opened this page
  // (File ▸ Digitise an Artwork…), can be brought to the front.
  const known = [hansketchWindow, window.opener].find(w => {
    try { return w && !w.closed && /\/hansketch\//.test(w.location.pathname); } catch { return false; }
  });
  if (known) {
    known.focus();
    toast('Sent to HanSketch.');
  } else if (Date.now() - hansketchSeenAt < 7000) {
    toast('Sent to your open HanSketch tab — switch to it to place the composition.');
  } else {
    hansketchWindow = window.open('../hansketch/hansketch.html', 'hansketch');
    toast(hansketchWindow ? 'Opening HanSketch…' : 'Pop-ups are blocked: open HanSketch yourself — the composition is waiting there.', !hansketchWindow);
  }
}

function exportComposition() {
  if (!comp.result) return;
  const blob = new Blob([compositionSvg()], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${comp.name.replace(/\.[^.]+$/, '') || 'artwork'}.composition.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Composition SVG saved. In HanSketch: drop it on the canvas or use File ▸ Import SVG.');
}

// ---------------------------------------------------------------- wiring

ui.modeButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
ui.imageInput.addEventListener('change', event => loadImageFile(event.target.files[0]));
for (const [key, control] of Object.entries(controls)) {
  control.input.addEventListener('input', () => {
    comp.settings[key] = Number(control.input.value);
    control.out.value = control.fmt(comp.settings[key]);
    saveSettings();
    analyseSoon();
  });
}
dropEdgeInput.addEventListener('change', () => {
  comp.settings.dropEdge = dropEdgeInput.checked;
  saveSettings();
  if (!comp.result) return;
  // No need to re-analyse: only the default inclusion of edge forms changes.
  comp.result.forms.forEach(form => {
    if (form.touchesEdge) comp.include.set(form.id, !comp.settings.dropEdge);
  });
  renderAll();
});
ui.reset.addEventListener('click', () => {
  comp.settings = { ...DEFAULTS };
  saveSettings();
  syncControls();
  analyseSoon(0);
});
ui.exportSvg.addEventListener('click', exportComposition);
ui.send.addEventListener('click', sendToHanSketch);
ui.canvas.addEventListener('click', event => {
  const form = formAt(stagePoint(event));
  if (!form) return;
  comp.include.set(form.id, !comp.include.get(form.id));
  renderAll();
});
ui.canvas.addEventListener('pointermove', event => {
  const form = formAt(stagePoint(event));
  const id = form ? form.id : null;
  if (id !== comp.hover) { comp.hover = id; renderStage(); }
});
ui.canvas.addEventListener('pointerleave', () => { comp.hover = null; renderStage(); });
['dragenter', 'dragover'].forEach(type => ui.stage.addEventListener(type, event => {
  event.preventDefault();
  ui.stage.classList.add('drag-over');
}));
['dragleave', 'drop'].forEach(type => ui.stage.addEventListener(type, event => {
  event.preventDefault();
  ui.stage.classList.remove('drag-over');
}));
ui.stage.addEventListener('drop', event => loadImageFile(event.dataTransfer.files[0]));

// An image opened in single-form mode is offered here too, so switching modes
// does not mean opening the same file twice.
window.addEventListener('shapeextractor:image', event => {
  if (!comp.image && event.detail?.image) useImage(event.detail.image, event.detail.name);
});

syncControls();
renderAll();
let initialMode = 'single';
try { initialMode = localStorage.getItem(MODE_KEY) === 'composition' ? 'composition' : 'single'; } catch { /* ignore */ }
if (new URLSearchParams(location.search).get('mode') === 'composition') initialMode = 'composition';
setMode(initialMode);

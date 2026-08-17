/* Person-only suggestion worker. A pose must be recognised before any mask
   is returned, so unrelated objects are never selected automatically. */
let width = 0;
let height = 0;
let sourceBitmap = null;
let sourceToken = 0;
let poseLandmarker = null;
let posePromise = null;
let poseModelPromise = null;
let poseInitializationMessage = '';

const POSE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const PACKAGE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35';

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === 'source') {
    setSource(message);
    return;
  }
  if (message.type === 'suggest') await suggestPerson(message);
};

function setSource(message) {
  if (sourceBitmap?.close) sourceBitmap.close();
  width = Number(message.width) || 0;
  height = Number(message.height) || 0;
  sourceBitmap = message.bitmap || null;
  sourceToken = Number(message.token) || 0;
  if (!posePromise) void initializePoseLandmarker();
}

async function initializePoseLandmarker() {
  if (posePromise) return posePromise;
  self.postMessage({ type: 'status', text: 'Loading the MediaPipe vision runtime…' });
  posePromise = (async () => {
    const vision = await import(PACKAGE_URL);
    self.postMessage({ type: 'status', text: 'Starting the vision runtime…' });
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    const options = {
      baseOptions: { modelAssetBuffer: new Uint8Array(await loadPoseModel()), delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: .55,
      minPosePresenceConfidence: .55,
      outputSegmentationMasks: true
    };
    self.postMessage({ type: 'status', text: 'Preparing the person model…' });
    return vision.PoseLandmarker.createFromOptions(fileset, options);
  })();
  try {
    poseLandmarker = await posePromise;
    poseInitializationMessage = '';
    self.postMessage({ type: 'ready', poseLandmarker: true });
    return poseLandmarker;
  } catch (error) {
    posePromise = null;
    poseInitializationMessage = recognitionErrorText(error);
    self.postMessage({ type: 'ready', poseLandmarker: false, text: poseInitializationMessage });
    return null;
  }
}

async function loadPoseModel() {
  if (!poseModelPromise) {
    poseModelPromise = (async () => {
      self.postMessage({ type: 'status', text: 'Downloading the person model…' });
      const response = await fetch(POSE_MODEL_URL);
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body?.getReader();
      if (!reader) return response.arrayBuffer();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) self.postMessage({ type: 'progress', loaded, total });
      }
      if (!loaded) throw new Error('The downloaded person model was empty.');
      const model = new Uint8Array(loaded);
      let offset = 0;
      chunks.forEach((chunk) => {
        model.set(chunk, offset);
        offset += chunk.length;
      });
      return model.buffer;
    })();
  }
  try {
    return await poseModelPromise;
  } catch (error) {
    poseModelPromise = null;
    throw error;
  }
}

function recognitionErrorText(error) {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return `Person recognition could not start${detail}. Use the mask tools to define the material.`;
}

async function suggestPerson(message) {
  const token = Number(message.token) || 0;
  if (!sourceBitmap || !width || !height || token !== sourceToken) {
    self.postMessage({ type: 'no-person', token, text: 'The image changed before person recognition could begin.' });
    return;
  }
  const landmarker = poseLandmarker || await initializePoseLandmarker();
  if (!landmarker || token !== sourceToken) {
    self.postMessage({ type: 'no-person', token, text: poseInitializationMessage || 'Person recognition is unavailable. Use the mask tools to define the material.' });
    return;
  }
  try {
    self.postMessage({ type: 'status', text: 'Looking for a person…' });
    const result = landmarker.detect(sourceBitmap);
    const landmarks = result?.landmarks?.[0];
    if (!hasRecognisedPerson(landmarks)) {
      self.postMessage({ type: 'no-person', token, text: 'No person was recognised in this image. Use the mask tools to define the material.' });
      return;
    }
    let mask = segmentationMask(result?.segmentationMasks?.[0]);
    if (!isUsefulMask(mask)) mask = poseFallbackMask(landmarks);
    if (!isUsefulMask(mask)) {
      self.postMessage({ type: 'no-person', token, text: 'A pose was recognised, but no usable person area was found. Use the mask tools to define the material.' });
      return;
    }
    const anchors = semanticAnchors(landmarks);
    self.postMessage({ type: 'result', token, width, height, mask: mask.buffer, anchors, backend: 'pose-landmarker' }, [mask.buffer]);
  } catch {
    self.postMessage({ type: 'error', token, text: 'Person recognition could not finish. Use the mask tools to define the material.' });
  }
}

function hasRecognisedPerson(landmarks) {
  return Array.isArray(landmarks) && landmarks.filter(isUsable).length >= 8;
}

function isUsable(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
  const confidence = Math.min(point.visibility ?? 1, point.presence ?? 1);
  return confidence >= .35;
}

function segmentationMask(segmentation) {
  if (!segmentation) return null;
  let values = null;
  try { values = segmentation.getAsFloat32Array?.() || segmentation.getAsUint8Array?.(); } catch { values = null; }
  if (!values?.length) return null;
  const maskWidth = Number(segmentation.width) || width;
  const maskHeight = Number(segmentation.height) || height;
  if (values.length < maskWidth * maskHeight) return null;
  let maximum = 0;
  for (let index = 0; index < values.length; index += 8) maximum = Math.max(maximum, values[index]);
  const threshold = maximum <= 1 ? .35 : maximum * .35;
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(maskHeight - 1, Math.floor(y * maskHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(maskWidth - 1, Math.floor(x * maskWidth / width));
      output[y * width + x] = values[sy * maskWidth + sx] > threshold ? 1 : 0;
    }
  }
  return output;
}

function semanticAnchors(landmarks) {
  const midpoint = (first, second) => {
    const a = landmarks[first];
    const b = landmarks[second];
    if (isUsable(a) && isUsable(b)) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, confidence: Math.min(a.visibility ?? 1, b.visibility ?? 1) };
    return isUsable(a) ? { x: a.x, y: a.y, confidence: a.visibility ?? 1 } : isUsable(b) ? { x: b.x, y: b.y, confidence: b.visibility ?? 1 } : null;
  };
  const direct = (kind, index) => isUsable(landmarks[index]) ? { kind, x: landmarks[index].x, y: landmarks[index].y, confidence: landmarks[index].visibility ?? 1 } : null;
  const centre = midpoint(23, 24) || midpoint(11, 12);
  const head = direct('head', 0);
  return [
    centre ? { kind: 'body_center', ...centre } : null,
    head,
    direct('left_hand', 15), direct('right_hand', 16),
    direct('left_foot', 31) || direct('left_foot', 27),
    direct('right_foot', 32) || direct('right_foot', 28)
  ].filter(Boolean);
}

function poseFallbackMask(landmarks) {
  const output = new Uint8Array(width * height);
  const shoulderWidth = distance(landmarks[11], landmarks[12]);
  const radius = Math.max(Math.min(width, height) * .015, shoulderWidth * .14, 5);
  const pairs = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31],
    [24, 26], [26, 28], [28, 32]
  ];
  pairs.forEach(([first, second]) => {
    if (isUsable(landmarks[first]) && isUsable(landmarks[second])) paintSegment(output, landmarks[first], landmarks[second], radius);
  });
  if (isUsable(landmarks[0])) paintDisk(output, landmarks[0].x * width, landmarks[0].y * height, radius * 1.35);
  return output;
}

function distance(a, b) {
  if (!isUsable(a) || !isUsable(b)) return Math.min(width, height) * .12;
  return Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
}

function paintSegment(mask, first, second, radius) {
  const x1 = first.x * width;
  const y1 = first.y * height;
  const x2 = second.x * width;
  const y2 = second.y * height;
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(1, radius * .55)));
  for (let step = 0; step <= steps; step += 1) paintDisk(mask, x1 + (x2 - x1) * step / steps, y1 + (y2 - y1) * step / steps, radius);
}

function paintDisk(mask, cx, cy, radius) {
  const rounded = Math.max(1, Math.round(radius));
  const minX = Math.max(0, Math.floor(cx - rounded));
  const maxX = Math.min(width - 1, Math.ceil(cx + rounded));
  const minY = Math.max(0, Math.floor(cy - rounded));
  const maxY = Math.min(height - 1, Math.ceil(cy + rounded));
  const radiusSquared = rounded * rounded;
  for (let y = minY; y <= maxY; y += 1) {
    const dy = y - cy;
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= radiusSquared) mask[y * width + x] = 1;
    }
  }
}

function isUsefulMask(mask) {
  if (!mask) return false;
  let selected = 0;
  for (let index = 0; index < mask.length; index += 1) selected += mask[index] ? 1 : 0;
  const coverage = selected / Math.max(1, mask.length);
  return coverage >= .0008 && coverage <= .88;
}

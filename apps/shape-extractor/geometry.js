// Pure contour geometry shared by the single-form extractor (app.js) and
// Composition mode (composition.js). No DOM, no state: masks in, rings out.

export function extractLoops(mask, width, height) {
  const stride = width + 1;
  const edges = [];
  const outgoing = new Map();
  const add = (ax, ay, bx, by) => {
    const start = ay * stride + ax;
    const end = by * stride + bx;
    const edge = { start, end };
    const index = edges.length;
    edges.push(edge);
    const list = outgoing.get(start);
    if (list) list.push(index);
    else outgoing.set(start, [index]);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (y === 0 || !mask[index - width]) add(x, y, x + 1, y);
      if (x === width - 1 || !mask[index + 1]) add(x + 1, y, x + 1, y + 1);
      if (y === height - 1 || !mask[index + width]) add(x + 1, y + 1, x, y + 1);
      if (x === 0 || !mask[index - 1]) add(x, y + 1, x, y);
    }
  }
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (used[edgeIndex]) continue;
    let edge = edges[edgeIndex];
    used[edgeIndex] = 1;
    const loop = [pointFromKey(edge.start, stride), pointFromKey(edge.end, stride)];
    const start = edge.start;
    let previous = edge.start;
    let current = edge.end;
    let safety = 0;
    while (current !== start && safety < edges.length + 4) {
      safety += 1;
      const options = (outgoing.get(current) || []).filter((index) => !used[index]);
      if (!options.length) break;
      const nextIndex = chooseNextEdge(options, edges, previous, current, stride);
      used[nextIndex] = 1;
      edge = edges[nextIndex];
      previous = current;
      current = edge.end;
      loop.push(pointFromKey(current, stride));
    }
    if (current === start && loop.length > 3) {
      loop.pop();
      loops.push(loop);
    }
  }
  return loops;
}

export function pointFromKey(key, stride) {
  return { x: key % stride, y: Math.floor(key / stride) };
}

export function chooseNextEdge(options, edges, previous, current, stride) {
  if (options.length === 1) return options[0];
  const from = pointFromKey(previous, stride);
  const at = pointFromKey(current, stride);
  const vx = at.x - from.x;
  const vy = at.y - from.y;
  let chosen = options[0];
  let highest = -Infinity;
  options.forEach((index) => {
    const end = pointFromKey(edges[index].end, stride);
    const nx = end.x - at.x;
    const ny = end.y - at.y;
    const cross = vx * ny - vy * nx;
    const dot = vx * nx + vy * ny;
    const score = cross * 10 + dot;
    if (score > highest) {
      highest = score;
      chosen = index;
    }
  });
  return chosen;
}

export function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function polygonCentroid(points) {
  let areaAcc = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    areaAcc += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (Math.abs(areaAcc) < .0001) {
    return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  }
  return { x: x / (3 * areaAcc), y: y / (3 * areaAcc) };
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function perimeter(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

export function resampleClosed(points, count) {
  if (points.length <= count) return points.map((point) => ({ ...point }));
  const lengths = [0];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(total);
  }
  const output = [];
  for (let sample = 0; sample < count; sample += 1) {
    const distance = total * sample / count;
    let segment = 0;
    while (segment < points.length - 1 && lengths[segment + 1] < distance) segment += 1;
    const a = points[segment];
    const b = points[(segment + 1) % points.length];
    const segmentLength = lengths[segment + 1] - lengths[segment] || 1;
    const t = (distance - lengths[segment]) / segmentLength;
    output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return output;
}

export function smoothClosed(points, rounds) {
  let current = points.map((point) => ({ ...point }));
  for (let round = 0; round < rounds; round += 1) {
    current = current.map((point, index) => {
      const previous = current[(index - 1 + current.length) % current.length];
      const next = current[(index + 1) % current.length];
      return { x: previous.x * .2 + point.x * .6 + next.x * .2, y: previous.y * .2 + point.y * .6 + next.y * .2 };
    });
  }
  return current;
}

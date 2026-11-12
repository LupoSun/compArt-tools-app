/* Small, bounded 2D studies. These are artistic models, not calibrated biology. */
(() => {
  "use strict";
  function random(seed) {
    let state = seed >>> 0;
    return () => {
      state += 0x6D2B79F5;
      let n = Math.imul(state ^ state >>> 15, 1 | state);
      n ^= n + Math.imul(n ^ n >>> 7, 61 | n);
      return ((n ^ n >>> 14) >>> 0) / 4294967296;
    };
  }
  function circle(x, y, radius, count = 64) {
    return Array.from({ length: count }, (_, i) => ({ x: x + Math.cos(i * 2 * Math.PI / count) * radius, y: y + Math.sin(i * 2 * Math.PI / count) * radius }));
  }
  function stains(width, height, seed) {
    const rng = random(seed), short = Math.min(width, height);
    return Array.from({ length: 12 }, () => {
      const x = width * (0.28 + rng() * 0.44), y = height * (0.28 + rng() * 0.44);
      const radius = short * (0.05 + rng() * 0.13), phase = rng() * Math.PI * 2;
      return { opacity: 0.2 + rng() * 0.4, points: circle(0, 0, radius).map((p, i) => {
        const t = i * Math.PI * 2 / 64, k = 1 + 0.2 * Math.sin(3 * t + phase) + 0.1 * Math.cos(7 * t - phase);
        return { x: x + p.x * k, y: y + p.y * k };
      }) };
    });
  }
  function branches(width, height, seed, angle = 25, depth = 5) {
    const rng = random(seed), paths = [];
    const grow = (x, y, length, heading, level) => {
      const end = { x: x + Math.cos(heading) * length, y: y + Math.sin(heading) * length };
      paths.push([{ x, y }, end]);
      if (!level) return;
      for (const sign of [-1, 1]) grow(end.x, end.y, length * (0.65 + rng() * 0.12), heading + sign * angle * Math.PI / 180, level - 1);
    };
    grow(width / 2, height * 0.82, Math.min(width, height) * 0.22, -Math.PI / 2, Math.min(6, Math.max(1, depth)));
    return paths;
  }
  function growContour(obj, width, height, scale) {
    const growth = obj.growth, points = obj.chain;
    if (!growth?.running || points.length < 3 || !obj.isClosed || obj.holes?.length) return false;
    if (points.length > 3 && Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) < 1e-6) points.pop();
    if (points.length >= 600 || growth.steps >= 7200) { growth.running = false; return false; }
    const n = points.length;
    if (!obj._growthScratch || obj._growthScratch.length < n * 2) Object.defineProperty(obj, "_growthScratch", { value: new Float64Array(n * 2), writable: true, configurable: true });
    const scratch = obj._growthScratch;
    let cx = 0, cy = 0, area = 0, perimeter = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i], q = points[(i + 1) % n];
      scratch[i * 2] = p.x; scratch[i * 2 + 1] = p.y;
      cx += p.x; cy += p.y; area += p.x * q.y - q.x * p.y; perimeter += Math.hypot(q.x - p.x, q.y - p.y);
    }
    cx /= n; cy /= n;
    growth.initialPerimeter ||= perimeter;
    if (perimeter > growth.initialPerimeter * 3) { growth.running = false; return false; }
    const direction = area >= 0 ? 1 : -1;
    const rate = Math.max(0, Math.min(1, Number(growth.rate) || 0));
    const variation = Math.max(0, Math.min(1, Number(growth.variation) || 0));
    const phase = (Number(growth.seed) || 1) % 100 * 0.63;
    for (let i = 0; i < n; i++) {
      const p = points[i]; if (p.pinned) continue;
      const before = (i + n - 1) % n, after = (i + 1) % n;
      const tx = scratch[after * 2] - scratch[before * 2], ty = scratch[after * 2 + 1] - scratch[before * 2 + 1];
      const length = Math.hypot(tx, ty) || 1, theta = Math.atan2(p.y - cy, p.x - cx);
      const local = 1 - variation + variation * (0.15 + 1.7 * Math.sin(theta * 3 + phase) ** 2);
      const amount = rate * local * scale * 0.18;
      const x = p.x + direction * ty / length * amount, y = p.y - direction * tx / length * amount;
      if (x < scale * 8 || y < scale * 8 || x > width - scale * 8 || y > height - scale * 8) { growth.running = false; continue; }
      p.x = x; p.y = y;
    }
    growth.steps = (growth.steps || 0) + 1;
    return true;
  }
  window.HanSketchNature = Object.freeze({ circle, stains, branches, growContour });
})();

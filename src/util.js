import * as THREE from 'three';

/** Hash entier → [0, 1), déterministe. */
export function hash(i, j, s) {
  let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Prépare une géométrie pour mergeGeometries : non indexée, sans UV, transformée, couleur de sommet unie. */
export function part(geometry, hex, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rz = 0 } = {}) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  g.scale(sx, sy, sz);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let k = 0; k < colors.length; k += 3) colors.set([c.r, c.g, c.b], k);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Chemin échantillonné : positions xyz + longueurs cumulées. */
export function makePath(points) {
  const n = points.length;
  const xyz = new Float32Array(n * 3);
  const cum = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    xyz[k * 3] = points[k].x;
    xyz[k * 3 + 1] = points[k].y;
    xyz[k * 3 + 2] = points[k].z;
    if (k) cum[k] = cum[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
  }
  return { xyz, cum, length: cum[n - 1] ?? 0, count: n };
}

/** Position et direction (xz normalisée) à l'abscisse curviligne s sur un chemin. */
export function pointAt(path, s, out) {
  const { xyz, cum, count } = path;
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[lo]) / seg));
  const a = lo * 3;
  const b = hi * 3;
  out.x = xyz[a] + (xyz[b] - xyz[a]) * t;
  out.y = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * t;
  out.z = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * t;
  const dx = xyz[b] - xyz[a];
  const dz = xyz[b + 2] - xyz[a + 2];
  const len = Math.hypot(dx, dz) || 1;
  out.dx = dx / len;
  out.dz = dz / len;
  return out;
}

/**
 * Ajoute à `out` les points d'un chemin entre les abscisses s0 et s1 (dans ce sens, éventuellement
 * décroissant), en sautant les doublons consécutifs.
 */
export function slicePoints(path, s0, s1, out = []) {
  const { xyz, cum, count } = path;
  const push = (x, y, z) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - x) + Math.abs(last.z - z) > 1e-3) out.push({ x, y, z });
  };
  const p = pointAt(path, s0, {});
  push(p.x, p.y, p.z);
  if (s1 >= s0) {
    for (let k = 0; k < count; k++) if (cum[k] > s0 && cum[k] < s1) push(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 2]);
  } else {
    for (let k = count - 1; k >= 0; k--) if (cum[k] < s0 && cum[k] > s1) push(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 2]);
  }
  pointAt(path, s1, p);
  push(p.x, p.y, p.z);
  return out;
}

/** Étiquetage des composantes connexes (4-voisinage) d'une grille booléenne. */
export function label(w, h, isOn) {
  const labels = new Int32Array(w * h);
  const stack = [];
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (labels[i] || !isOn(i)) continue;
    next++;
    labels[i] = next;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j / w) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && !labels[k] && isOn(k)) {
          labels[k] = next;
          stack.push(k);
        }
      }
    }
  }
  return labels;
}

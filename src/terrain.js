import * as THREE from 'three';
import { BIOMES, DEFAULT_BIOME } from './biomes.js';
import { hash } from './util.js';

/** Échelle : 1 unité monde = 50 m (horizontalement comme verticalement). */
export const METERS_PER_UNIT = 50;
export const SEA_FLOOR = -5;
export const MIN_HEIGHT = -20;
export const MAX_HEIGHT = 60;

/** Couches de zones peintes (0..1), mutuellement exclusives au pinceau. */
export const ZONES = ['forest', 'town', 'fields'];

// Parcellaire des champs : grille tournée, parcelles d'environ 350 m x 225 m.
const FIELD_ANGLE = 0.35;
const FIELD_W = 7;
const FIELD_H = 4.5;
const FIELD_COS = Math.cos(FIELD_ANGLE);
const FIELD_SIN = Math.sin(FIELD_ANGLE);

const tmp = new THREE.Color();
const fieldTmp = new THREE.Color();
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function fieldColor(b, x, z, out) {
  const u = Math.floor((x * FIELD_COS + z * FIELD_SIN) / FIELD_W);
  const v = Math.floor((-x * FIELD_SIN + z * FIELD_COS) / FIELD_H);
  return out.copy(b.fieldColors[Math.floor(hash(u, v, 31) * b.fieldColors.length)]).multiplyScalar(0.92 + 0.16 * hash(u, v, 32));
}

function groundColor(b, h, slope, forest, town, fields, x, z, out) {
  const stops = b.landStops;
  if (h < stops[0].h) {
    out.lerpColors(b.deepColor, stops[0].c, clamp01((h - SEA_FLOOR) / (stops[0].h - SEA_FLOOR)) ** 1.5);
    return out;
  }
  let k = 0;
  while (k < stops.length - 1 && h >= stops[k + 1].h) k++;
  if (k === stops.length - 1) out.copy(stops[k].c);
  else out.lerpColors(stops[k].c, stops[k + 1].c, (h - stops[k].h) / (stops[k + 1].h - stops[k].h));

  if (h > 0.8) out.lerp(b.rockColor, smoothstep(b.rockSlope[0], b.rockSlope[1], slope));
  if (h > b.snowLine - 2) out.lerp(b.snowColor, smoothstep(b.snowLine - 2, b.snowLine + 1, h) * (1 - smoothstep(0.55, 0.8, slope)));

  // Teinte du sol sous les zones de forêt / ville, pour les voir de loin.
  if (h > 0.3) {
    if (forest > 0) out.lerp(b.forestGroundColor, forest * 0.55 * (1 - smoothstep(0.4, 0.7, slope)));
    if (town > 0) out.lerp(b.townGroundColor, town * 0.75);
    if (fields > 0 && h > 0.6) out.lerp(fieldColor(b, x, z, fieldTmp), Math.min(1, fields * 1.2) * (1 - smoothstep(0.25, 0.45, slope)));
  }
  return out;
}

/**
 * Terrain basé sur une heightmap carrée de `resolution` x `resolution` sommets,
 * couvrant `size` x `size` unités monde, centrée sur l'origine.
 * Ligne r ↔ z = -size/2 + r*cell, colonne c ↔ x = -size/2 + c*cell.
 * Trois couches de zones (0..1) accompagnent les hauteurs : forêt, ville et champs.
 */
export class Terrain {
  constructor({ size = 400, resolution = 513 } = {}) {
    this.size = size;
    this.res = resolution;
    this.cell = size / (resolution - 1);
    const n = resolution * resolution;
    this.heights = new Float32Array(n).fill(SEA_FLOOR);
    this.forest = new Float32Array(n);
    this.town = new Float32Array(n);
    this.fields = new Float32Array(n);
    this.biome = BIOMES[DEFAULT_BIOME];

    // Bruit fixe par sommet pour casser l'uniformité des couleurs.
    this.noise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      this.noise[i] = (s - Math.floor(s)) * 2 - 1;
    }

    const geometry = new THREE.PlaneGeometry(size, size, resolution - 1, resolution - 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    for (const name of ['position', 'normal', 'color']) geometry.attributes[name].setUsage(THREE.DynamicDrawUsage);
    this.geometry = geometry;

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    this.refreshAll();
  }

  get layers() {
    return { heights: this.heights, forest: this.forest, town: this.town, fields: this.fields };
  }

  setBiome(id) {
    this.biome = BIOMES[id] ?? BIOMES[DEFAULT_BIOME];
    this.refreshAll();
  }

  worldToGrid(x, z) {
    return [(x + this.size / 2) / this.cell, (z + this.size / 2) / this.cell];
  }

  /** Échantillonnage bilinéaire d'une couche en coordonnées monde. */
  sample(arr, x, z) {
    const { res } = this;
    let [gc, gr] = this.worldToGrid(x, z);
    gc = Math.min(Math.max(gc, 0), res - 1);
    gr = Math.min(Math.max(gr, 0), res - 1);
    const c0 = Math.min(Math.floor(gc), res - 2);
    const r0 = Math.min(Math.floor(gr), res - 2);
    const fc = gc - c0;
    const fr = gr - r0;
    const i = r0 * res + c0;
    const top = arr[i] * (1 - fc) + arr[i + 1] * fc;
    const bottom = arr[i + res] * (1 - fc) + arr[i + res + 1] * fc;
    return top * (1 - fr) + bottom * fr;
  }

  heightAt(x, z) {
    return this.sample(this.heights, x, z);
  }

  /** Pente au sommet le plus proche : 0 = plat, 1 = vertical. */
  slopeAt(x, z) {
    const [gc, gr] = this.worldToGrid(x, z);
    const c = Math.min(Math.max(Math.round(gc), 0), this.res - 1);
    const r = Math.min(Math.max(Math.round(gr), 0), this.res - 1);
    return 1 - this.geometry.attributes.normal.array[(r * this.res + c) * 3 + 1];
  }

  inside(x, z) {
    const h = this.size / 2;
    return x >= -h && x <= h && z >= -h && z <= h;
  }

  /** Intersection rayon / heightfield par marche + dichotomie. Renvoie un Vector3 ou null. */
  raycast(ray, target = new THREE.Vector3()) {
    const half = this.size / 2;
    const o = ray.origin;
    const d = ray.direction;
    let tmin = 0;
    let tmax = Infinity;
    for (const [axis, lo, hi] of [['x', -half, half], ['y', MIN_HEIGHT, MAX_HEIGHT], ['z', -half, half]]) {
      if (Math.abs(d[axis]) < 1e-9) {
        if (o[axis] < lo || o[axis] > hi) return null;
        continue;
      }
      let t1 = (lo - o[axis]) / d[axis];
      let t2 = (hi - o[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }

    const below = (t) => o.y + d.y * t <= this.heightAt(o.x + d.x * t, o.z + d.z * t);
    const step = this.cell * 0.5;
    let prev = tmin;
    for (let t = tmin; t <= tmax + step; t += step) {
      const tt = Math.min(t, tmax);
      if (below(tt)) {
        let lo = prev;
        let hi = tt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          if (below(mid)) hi = mid;
          else lo = mid;
        }
        return ray.at(hi, target);
      }
      prev = tt;
    }
    return null;
  }

  refreshAll() {
    this.refresh(0, 0, this.res - 1, this.res - 1);
  }

  /** Recalcule positions, normales et couleurs dans le rectangle de grille donné (inclus). */
  refresh(c0, r0, c1, r1) {
    const { res, heights, forest, town, fields, cell, noise, biome } = this;
    const half = this.size / 2;
    c0 = Math.max(0, c0 - 1);
    r0 = Math.max(0, r0 - 1);
    c1 = Math.min(res - 1, c1 + 1);
    r1 = Math.min(res - 1, r1 + 1);

    const { position, normal, color } = this.geometry.attributes;
    const pos = position.array;
    const nor = normal.array;
    const col = color.array;

    for (let r = r0; r <= r1; r++) {
      const up = Math.max(r - 1, 0) * res;
      const down = Math.min(r + 1, res - 1) * res;
      for (let c = c0; c <= c1; c++) {
        const i = r * res + c;
        const h = heights[i];
        pos[i * 3 + 1] = h;

        let nx = heights[r * res + Math.max(c - 1, 0)] - heights[r * res + Math.min(c + 1, res - 1)];
        let ny = 2 * cell;
        let nz = heights[up + c] - heights[down + c];
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        nor[i * 3] = nx;
        nor[i * 3 + 1] = ny;
        nor[i * 3 + 2] = nz;

        groundColor(biome, h, 1 - ny, forest[i], town[i], fields[i], -half + c * cell, -half + r * cell, tmp).multiplyScalar(1 + noise[i] * 0.05);
        col[i * 3] = tmp.r;
        col[i * 3 + 1] = tmp.g;
        col[i * 3 + 2] = tmp.b;
      }
    }

    const start = r0 * res * 3;
    const count = (r1 - r0 + 1) * res * 3;
    for (const attr of [position, normal, color]) {
      attr.addUpdateRange(start, count);
      attr.needsUpdate = true;
    }
  }

  /** Remplace les couches fournies ({ heights?, forest?, town?, fields? }). */
  setLayers(layers) {
    for (const [k, v] of Object.entries(layers)) if (v) this[k].set(v);
    this.refreshAll();
  }

  reset() {
    this.heights.fill(SEA_FLOOR);
    this.forest.fill(0);
    this.town.fill(0);
    this.fields.fill(0);
    this.refreshAll();
  }

  /** Surface émergée en km². */
  landArea() {
    let n = 0;
    for (const h of this.heights) if (h > 0) n++;
    return (n * (this.cell * METERS_PER_UNIT) ** 2) / 1e6;
  }

  /** Vignette vue de dessus (data URL JPEG) générée à partir des couleurs du terrain. */
  thumbnail(px = 96) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(px, px);
    const col = this.geometry.attributes.color.array;
    const water = new THREE.Color(this.biome.water);
    const c = new THREE.Color();
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const gc = Math.round((x / (px - 1)) * (this.res - 1));
        const gr = Math.round((y / (px - 1)) * (this.res - 1));
        const i = gr * this.res + gc;
        c.setRGB(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
        const h = this.heights[i];
        if (h < 0) c.lerp(water, 0.45 + 0.4 * clamp01(-h / 5));
        c.convertLinearToSRGB();
        const o = (y * px + x) * 4;
        img.data[o] = c.r * 255;
        img.data[o + 1] = c.g * 255;
        img.data[o + 2] = c.b * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }
}

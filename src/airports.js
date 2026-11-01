import * as THREE from 'three';
import { ZONES } from './terrain.js';

export const RUNWAY_DEFAULT = 32; // ≈ 1,6 km
export const RUNWAY_MIN = 18;
export const RUNWAY_MAX = 60;
const RUNWAY_WIDTH = 0.9;
const TAXI_OFFSET = 1.7; // axe du taxiway, côté aérogare
const APRON_OFFSET = 3.4; // axe de l'aire de stationnement
const GATES = 4;
const MIN_LAND = 0.5; // part minimale de terre sous l'emprise
const BLEND = 5; // raccord progressif du terrain aplani
const PICK_DISTANCE = 3;

/**
 * Aéroports : une piste (x1, z1) → (x2, z2), aplanie à l'altitude `y`, et du côté `side` de la piste
 * (+1 / −1 selon la normale (−uz, ux)) un taxiway, une aire de stationnement, une aérogare, une tour
 * et un hangar.
 */

/** Repère d'un aéroport : centre, axe de piste u, normale n vers l'aérogare, longueur. */
export function frame(a) {
  const dx = a.x2 - a.x1;
  const dz = a.z2 - a.z1;
  const L = Math.hypot(dx, dz);
  const ux = dx / L;
  const uz = dz / L;
  return { cx: (a.x1 + a.x2) / 2, cz: (a.z1 + a.z2) / 2, ux, uz, nx: -uz * a.side, nz: ux * a.side, L, y: a.y };
}

/** Point monde à l'abscisse u (le long de la piste, depuis le centre) et au décalage n. */
export function at(f, u, n) {
  return { x: f.cx + f.ux * u + f.nx * n, z: f.cz + f.uz * u + f.nz * n };
}

export const TAXI = TAXI_OFFSET;
export const APRON = APRON_OFFSET;

/** Positions de stationnement (abscisses u sur l'aire). */
export const gateU = (f, g) => (g - (GATES - 1) / 2) * Math.min(3, (f.L * 0.3) / GATES);
export const GATE_COUNT = GATES;

/** Emprise aplanie, en coordonnées (u, n). */
const footprint = (L) => ({ u0: -L / 2 - 1.5, u1: L / 2 + 1.5, n0: -2, n1: APRON_OFFSET + 3 });

export class Airports {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.list = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
    this.materials = {
      runway: mat(0x3b3e43, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      taxi: mat(0x55585d, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      apron: mat(0x777a7e, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      paint: mat(0xf2f2f0, { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      terminal: mat(0xdfe3e8),
      glass: mat(0x6c9fc0, { roughness: 0.3, metalness: 0.2 }),
      roof: mat(0x8a9097),
      hangar: mat(0x9aa6b2),
      beacon: new THREE.MeshStandardMaterial({ color: 0xe33b2e, emissive: 0x6a0d06 }),
    };
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);

    // Préparation (aperçu de la piste pendant le tracé).
    this.preview = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4), 3)),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
    );
    this.preview.renderOrder = 1000;
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    scene.add(this.preview);

    // Balisage lumineux, visible la nuit.
    this.lights = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 2.5, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.lights.frustumCulled = false;
    this.lights.visible = false;
    scene.add(this.lights);
  }

  setLightsLevel(level) {
    this.lights.material.opacity = level;
    this.lights.visible = level > 0.01 && this.list.length > 0;
  }

  /** Piste par défaut autour de (x, z) : orientation où le terrain est le plus plat et le plus émergé. */
  autoRunway(x, z, length = RUNWAY_DEFAULT) {
    let best = null;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI;
      const c = { x1: x - (Math.cos(a) * length) / 2, z1: z - (Math.sin(a) * length) / 2, x2: x + (Math.cos(a) * length) / 2, z2: z + (Math.sin(a) * length) / 2 };
      for (const side of [1, -1]) {
        const cand = { ...c, side };
        const { land, spread } = this.survey(cand);
        const score = spread + (1 - land) * 40;
        if (!best || score < best.score) best = { cand, score };
      }
    }
    return best.cand;
  }

  /** Relevé du terrain sous l'emprise : part de terre, altitude moyenne des terres, dispersion. */
  survey(a) {
    const f = frame(a);
    const fp = footprint(f.L);
    const t = this.terrain;
    let n = 0;
    let landN = 0;
    let sum = 0;
    let sum2 = 0;
    let inside = true;
    for (let u = fp.u0; u <= fp.u1; u += 1.5) {
      for (let v = fp.n0; v <= fp.n1; v += 1) {
        const p = at(f, u, v);
        if (!t.inside(p.x, p.z)) inside = false;
        const h = t.heightAt(p.x, p.z);
        n++;
        if (h > 0.05) {
          landN++;
          sum += h;
          sum2 += h * h;
        }
      }
    }
    const mean = landN ? sum / landN : 0;
    return { inside, land: landN / n, mean, spread: landN ? Math.sqrt(Math.max(0, sum2 / landN - mean * mean)) : 99 };
  }

  /** Vérifie un emplacement ; renvoie un message d'erreur ou null. */
  check(a) {
    const s = this.survey(a);
    if (!s.inside) return 'La piste sort de la zone';
    if (s.land < MIN_LAND) return 'Pas assez de terre pour une piste';
    const f = frame(a);
    for (const other of this.list) {
      const o = frame(other);
      if (Math.hypot(o.cx - f.cx, o.cz - f.cz) < (o.L + f.L) / 2 + 4) return 'Trop près d\'un autre aéroport';
    }
    return null;
  }

  /**
   * Crée l'aéroport : aplanit le terrain sous l'emprise (avec un raccord progressif) et efface les
   * zones (forêt, ville, champs). Renvoie l'aéroport.
   */
  place(a, name) {
    const s = this.survey(a);
    const airport = { ...a, y: Math.max(0.6, s.mean), name };
    const f = frame(airport);
    const fp = footprint(f.L);
    const t = this.terrain;
    const { res, cell, heights } = t;
    const half = t.size / 2;
    // Boîte englobante de l'emprise élargie.
    const corners = [[fp.u0, fp.n0], [fp.u1, fp.n0], [fp.u0, fp.n1], [fp.u1, fp.n1]].map(([u, v]) => at(f, u, v));
    const xs = corners.map((p) => p.x);
    const zs = corners.map((p) => p.z);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - BLEND + half) / cell));
    const c1 = Math.min(res - 1, Math.ceil((Math.max(...xs) + BLEND + half) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(...zs) - BLEND + half) / cell));
    const r1 = Math.min(res - 1, Math.ceil((Math.max(...zs) + BLEND + half) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = -half + c * cell - f.cx;
        const z = -half + r * cell - f.cz;
        const u = x * f.ux + z * f.uz;
        const v = x * f.nx + z * f.nz;
        // Distance hors de l'emprise (0 dedans).
        const du = Math.max(fp.u0 - u, 0, u - fp.u1);
        const dv = Math.max(fp.n0 - v, 0, v - fp.n1);
        const d = Math.hypot(du, dv);
        if (d >= BLEND) continue;
        const w = d === 0 ? 1 : 1 - d / BLEND;
        const k = w * w * (3 - 2 * w);
        const i = r * res + c;
        heights[i] += (airport.y - heights[i]) * k;
        if (d === 0) for (const z of ZONES) t[z][i] = 0;
      }
    }
    t.refresh(c0, r0, c1, r1);
    this.list.push(airport);
    this.rebuild();
    return airport;
  }

  pick(x, z) {
    let best = -1;
    let bestD = PICK_DISTANCE;
    this.list.forEach((a, i) => {
      const f = frame(a);
      const px = x - f.cx;
      const pz = z - f.cz;
      const u = px * f.ux + pz * f.uz;
      const v = px * f.nx + pz * f.nz;
      const d = Math.hypot(Math.max(Math.abs(u) - f.L / 2, 0), Math.max(-2 - v, 0, v - APRON_OFFSET - 2.5));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  remove(index) {
    this.list.splice(index, 1);
    this.rebuild();
  }

  /** Aperçu de l'emprise de la piste (couleur selon validité). */
  updatePreview(a, valid) {
    this.preview.visible = !!a;
    if (!a) return;
    const f = frame(a);
    const pos = this.preview.geometry.attributes.position;
    [[-f.L / 2, -RUNWAY_WIDTH], [f.L / 2, -RUNWAY_WIDTH], [f.L / 2, APRON_OFFSET + 1.5], [-f.L / 2, APRON_OFFSET + 1.5]].forEach(([u, v], k) => {
      const p = at(f, u, v);
      pos.setXYZ(k, p.x, Math.max(this.terrain.heightAt(p.x, p.z), 0) + 0.3, p.z);
    });
    pos.needsUpdate = true;
    this.preview.material.color.setHex(valid ? 0x9ef0a0 : 0xff6b5f);
  }

  rebuild() {
    for (const child of [...this.group.children]) this.group.remove(child);
    const m = this.materials;
    const lights = [];
    const colors = [];
    const light = (p, y, hex) => {
      lights.push(p.x, y, p.z);
      const c = new THREE.Color(hex);
      colors.push(c.r, c.g, c.b);
    };
    for (const a of this.list) {
      const f = frame(a);
      const rot = Math.atan2(-f.uz, f.ux);
      const add = (geometry, material, u, v, y, sx, sy, sz, shadow = true) => {
        const p = at(f, u, v);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(p.x, f.y + y, p.z);
        mesh.scale.set(sx, sy, sz);
        mesh.rotation.y = rot;
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      };
      // Piste, marquages (axe, seuils), taxiway, bretelles, aire de stationnement.
      add(this.box, m.runway, 0, 0, 0.03, f.L, 0.04, RUNWAY_WIDTH, false);
      for (let u = -f.L / 2 + 3; u < f.L / 2 - 3; u += 2) add(this.box, m.paint, u + 0.5, 0, 0.051, 1, 0.005, 0.05, false);
      for (const end of [-1, 1]) {
        for (let k = -3; k <= 3; k++) add(this.box, m.paint, end * (f.L / 2 - 0.9), k * 0.11, 0.051, 1, 0.005, 0.06, false);
      }
      add(this.box, m.taxi, 0, TAXI_OFFSET, 0.025, f.L * 0.92, 0.04, 0.45, false);
      for (const end of [-1, 1]) add(this.box, m.taxi, end * f.L * 0.44, TAXI_OFFSET / 2, 0.025, 0.45, 0.04, TAXI_OFFSET, false);
      add(this.box, m.taxi, 0, (TAXI_OFFSET + APRON_OFFSET) / 2, 0.025, 0.45, 0.04, APRON_OFFSET - TAXI_OFFSET, false);
      const apronLen = Math.min(14, f.L * 0.4);
      add(this.box, m.apron, 0, APRON_OFFSET, 0.028, apronLen, 0.04, 2.2, false);
      // Aérogare (bâtiment vitré), tour de contrôle, hangar.
      add(this.box, m.terminal, 0, APRON_OFFSET + 1.9, 0.3, apronLen * 0.8, 0.6, 1, true);
      add(this.box, m.glass, 0, APRON_OFFSET + 1.38, 0.3, apronLen * 0.8, 0.3, 0.04, false);
      add(this.box, m.roof, 0, APRON_OFFSET + 1.9, 0.63, apronLen * 0.82, 0.06, 1.05, true);
      const towerU = apronLen * 0.5 + 1;
      add(this.cyl, m.terminal, towerU, APRON_OFFSET + 1.6, 0.9, 0.28, 1.8, 0.28, true);
      add(this.box, m.glass, towerU, APRON_OFFSET + 1.6, 1.9, 0.55, 0.28, 0.55, true);
      add(this.box, m.roof, towerU, APRON_OFFSET + 1.6, 2.07, 0.62, 0.05, 0.62, true);
      add(this.cyl, m.beacon, towerU, APRON_OFFSET + 1.6, 2.17, 0.06, 0.14, 0.06, false);
      add(this.box, m.hangar, -apronLen * 0.5 - 1.4, APRON_OFFSET + 1.2, 0.4, 2, 0.8, 1.6, true);
      // Balisage : bords de piste blancs, seuils verts / rouges, aérogare.
      for (let u = -f.L / 2; u <= f.L / 2 + 0.01; u += 1.6) {
        for (const v of [-RUNWAY_WIDTH / 2 - 0.05, RUNWAY_WIDTH / 2 + 0.05]) light(at(f, u, v), f.y + 0.12, 0xfff4d8);
      }
      for (let k = -3; k <= 3; k++) {
        light(at(f, -f.L / 2 - 0.15, k * 0.13), f.y + 0.12, 0x6cff8a);
        light(at(f, f.L / 2 + 0.15, k * 0.13), f.y + 0.12, 0xff5a4a);
      }
      for (let u = -apronLen * 0.4; u <= apronLen * 0.4; u += 1) light(at(f, u, APRON_OFFSET + 1.36), f.y + 0.35, 0xffd890);
      light(at(f, towerU, APRON_OFFSET + 1.6), f.y + 2.3, 0xff4a3a);
    }
    const g = this.lights.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }

  /** Emprise (pas d'arbres ni de bâtiments). */
  rasterize(mask) {
    const t = this.terrain;
    for (const a of this.list) {
      const f = frame(a);
      const fp = footprint(f.L);
      for (let u = fp.u0; u <= fp.u1; u += t.cell * 0.7) {
        for (let v = fp.n0; v <= fp.n1; v += t.cell * 0.7) {
          const p = at(f, u, v);
          const [gc, gr] = t.worldToGrid(p.x, p.z);
          const c = Math.round(gc);
          const r = Math.round(gr);
          if (r >= 0 && c >= 0 && r < t.res && c < t.res) mask[r * t.res + c] = 1;
        }
      }
    }
  }

  toJSON() {
    const r = (v) => Math.round(v * 100) / 100;
    return this.list.map((a) => ({ x1: r(a.x1), z1: r(a.z1), x2: r(a.x2), z2: r(a.z2), side: a.side, y: r(a.y), name: a.name }));
  }

  fromJSON(arr) {
    this.list = structuredClone(arr ?? []);
    this.rebuild();
  }

  snapshot() {
    return structuredClone(this.list);
  }

  restore(s) {
    this.list = structuredClone(s);
    this.rebuild();
  }
}

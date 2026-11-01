import * as THREE from 'three';

const SEARCH_SHORE = 8; // rayon de recherche de la côte autour du clic (unités)
const SEARCH_DOCK = 8; // distance max entre la côte et l'eau assez profonde
const DOCK_DEPTH = -0.8;
const PICK_DISTANCE = 3;

/**
 * Ports : un ponton qui part de la côte (`x, z`) vers l'eau profonde (`dx, dz`, où accostent
 * les bateaux), plus un entrepôt et un fanal.
 */
export class Ports {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.list = []; // [{ x, z, dx, dz }]
    this.group = new THREE.Group();
    scene.add(this.group);
    this.materials = {
      wood: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9, flatShading: true }),
      shed: new THREE.MeshStandardMaterial({ color: 0xb0a492, roughness: 0.8, flatShading: true }),
      roof: new THREE.MeshStandardMaterial({ color: 0x6a4a3a, roughness: 0.8, flatShading: true }),
      light: new THREE.MeshStandardMaterial({ color: 0xd8392b, emissive: 0x5a0a05, roughness: 0.5 }),
      mast: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }),
    };
    this.geometries = {
      box: new THREE.BoxGeometry(1, 1, 1),
      mast: new THREE.CylinderGeometry(0.04, 0.05, 1, 6).translate(0, 0.5, 0),
      light: new THREE.SphereGeometry(0.07, 8, 6),
    };
  }

  /** Cherche la côte la plus proche du point et l'eau profonde en face. Renvoie le port créé ou null. */
  place(p) {
    const t = this.terrain;
    const { res, cell, heights } = t;
    const [gc, gr] = t.worldToGrid(p.x, p.z);
    const R = Math.ceil(SEARCH_SHORE / cell);
    let shore = null;
    let best = Infinity;
    for (let r = Math.max(1, Math.round(gr) - R); r <= Math.min(res - 2, Math.round(gr) + R); r++) {
      for (let c = Math.max(1, Math.round(gc) - R); c <= Math.min(res - 2, Math.round(gc) + R); c++) {
        const i = r * res + c;
        if (heights[i] <= 0.05) continue;
        if (heights[i - 1] > 0 && heights[i + 1] > 0 && heights[i - res] > 0 && heights[i + res] > 0) continue;
        const d = Math.hypot(c - gc, r - gr);
        if (d < best) {
          best = d;
          shore = { c, r };
        }
      }
    }
    if (!shore) return null;

    const D = Math.ceil(SEARCH_DOCK / cell);
    let dock = null;
    best = Infinity;
    for (let r = Math.max(0, shore.r - D); r <= Math.min(res - 1, shore.r + D); r++) {
      for (let c = Math.max(0, shore.c - D); c <= Math.min(res - 1, shore.c + D); c++) {
        if (heights[r * res + c] > DOCK_DEPTH) continue;
        const d = Math.hypot(c - shore.c, r - shore.r);
        if (d < best) {
          best = d;
          dock = { c, r };
        }
      }
    }
    if (!dock) return null;

    const half = t.size / 2;
    const port = { x: -half + shore.c * cell, z: -half + shore.r * cell, dx: -half + dock.c * cell, dz: -half + dock.r * cell };
    // Ponton d'au moins 1 unité pour rester visible.
    const len = Math.hypot(port.dx - port.x, port.dz - port.z);
    if (len < 1) {
      const k = 1 / (len || 1);
      port.dx = port.x + (port.dx - port.x) * k;
      port.dz = port.z + (port.dz - port.z) * k;
    }
    this.list.push(port);
    this.rebuild();
    return port;
  }

  pick(x, z) {
    let best = -1;
    let bestD = PICK_DISTANCE;
    this.list.forEach((p, i) => {
      const d = Math.min(Math.hypot(p.x - x, p.z - z), Math.hypot(p.dx - x, p.dz - z));
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

  rebuild() {
    for (const child of [...this.group.children]) this.group.remove(child);
    const { box, mast, light } = this.geometries;
    const m = this.materials;
    const add = (geometry, material, x, y, z, sx, sy, sz, rot) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.y = rot;
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    for (const p of this.list) {
      const vx = p.dx - p.x;
      const vz = p.dz - p.z;
      const len = Math.hypot(vx, vz);
      const ux = vx / len;
      const uz = vz / len;
      const rot = Math.atan2(-uz, ux);
      // Ponton : de la côte (un peu à l'intérieur des terres) jusqu'au point d'accostage.
      const start = -0.4;
      const mid = (start + len) / 2;
      add(box, m.wood, p.x + ux * mid, 0.28, p.z + uz * mid, len - start, 0.1, 0.32, rot);
      // Entrepôt sur la terre ferme, en retrait.
      const hx = p.x - ux * 0.9;
      const hz = p.z - uz * 0.9;
      const hy = Math.max(this.terrain.heightAt(hx, hz), 0.2);
      add(box, m.shed, hx, hy + 0.15, hz, 0.4, 0.4, 0.75, rot);
      add(box, m.roof, hx, hy + 0.37, hz, 0.46, 0.06, 0.8, rot);
      // Fanal au bout du ponton.
      add(mast, m.mast, p.dx, 0.3, p.dz, 1, 0.5, 1, 0);
      add(light, m.light, p.dx, 0.85, p.dz, 1, 1, 1, 0);
    }
  }

  rasterize(mask) {
    const t = this.terrain;
    for (const p of this.list) {
      for (let k = -2; k <= 4; k++) {
        const s = k / 4;
        const x = p.x + (p.x - p.dx) * s * 0.4;
        const z = p.z + (p.z - p.dz) * s * 0.4;
        const [gc, gr] = t.worldToGrid(x, z);
        for (let rr = Math.round(gr) - 2; rr <= Math.round(gr) + 2; rr++) {
          for (let cc = Math.round(gc) - 2; cc <= Math.round(gc) + 2; cc++) {
            if (rr >= 0 && cc >= 0 && rr < t.res && cc < t.res) mask[rr * t.res + cc] = 1;
          }
        }
      }
    }
  }

  toJSON() {
    const r = (v) => Math.round(v * 100) / 100;
    return this.list.map((p) => ({ x: r(p.x), z: r(p.z), dx: r(p.dx), dz: r(p.dz) }));
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

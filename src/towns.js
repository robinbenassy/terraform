import { METERS_PER_UNIT } from './terrain.js';
import { label } from './util.js';
import { townName } from './names.js';

export const TOWN_THRESHOLD = 0.3;
const STEP = 2; // grille de détection : une case du terrain sur deux
const MIN_AREA = 0.04; // km² : en dessous, quelques maisons isolées, pas une ville
const MATCH_RADIUS = 3; // tolérance (cases de détection) pour retrouver une ville par son ancre

/**
 * Villes : composantes connexes du masque de ville, chacune avec un nom.
 *
 * Les noms sont stockés avec une ancre (`names: [{ x, z, name }]`, sauvegardée avec l'île). À chaque
 * recalcul, une ville reprend le nom dont l'ancre tombe sur elle, et l'ancre suit le centre de la
 * ville ; une ville sans nom en reçoit un généré selon le biome. Les noms dont la ville a disparu
 * sont oubliés (l'historique permet de les retrouver).
 */
export class Towns {
  constructor(terrain) {
    this.terrain = terrain;
    this.names = [];
    this.list = []; // [{ id, x, z, cells, area (km²), entry }] du plus grand au plus petit
    this.w = Math.ceil(terrain.res / STEP);
    this.labels = new Int32Array(this.w * this.w);
    this.byId = new Map();
  }

  /** Identifiant de la ville en (x, z), ou 0. */
  idAt(x, z) {
    const [gc, gr] = this.terrain.worldToGrid(x, z);
    const c = Math.min(this.w - 1, Math.max(0, Math.round(gc / STEP)));
    const r = Math.min(this.w - 1, Math.max(0, Math.round(gr / STEP)));
    return this.labels[r * this.w + c];
  }

  update() {
    const t = this.terrain;
    const { w } = this;
    const cellSize = STEP * t.cell;
    const toWorld = (i) => [-t.size / 2 + (i % w) * cellSize, -t.size / 2 + ((i / w) | 0) * cellSize];
    this.labels = label(w, w, (i) => t.town[Math.min(t.res - 1, ((i / w) | 0) * STEP) * t.res + Math.min(t.res - 1, (i % w) * STEP)] > TOWN_THRESHOLD);

    // Centres, puis case de la ville la plus proche du centre (ancre toujours dans la ville).
    const comps = new Map();
    for (let i = 0; i < w * w; i++) {
      const id = this.labels[i];
      if (!id) continue;
      const [x, z] = toWorld(i);
      const c = comps.get(id) ?? { id, sx: 0, sz: 0, cells: 0 };
      c.sx += x;
      c.sz += z;
      c.cells++;
      comps.set(id, c);
    }
    for (const c of comps.values()) {
      c.cx = c.sx / c.cells;
      c.cz = c.sz / c.cells;
      c.best = Infinity;
    }
    for (let i = 0; i < w * w; i++) {
      const c = comps.get(this.labels[i]);
      if (!c) continue;
      const [x, z] = toWorld(i);
      const d = (x - c.cx) ** 2 + (z - c.cz) ** 2;
      if (d < c.best) {
        c.best = d;
        c.x = x;
        c.z = z;
      }
    }

    // Noms existants : la ville sous l'ancre (ou tout près) reprend le nom.
    const named = new Map();
    for (const entry of this.names) {
      const id = this.findNear(entry.x, entry.z);
      if (id && !named.has(id)) named.set(id, entry);
    }

    const used = new Set([...named.values()].map((e) => e.name));
    const cellArea = (cellSize * METERS_PER_UNIT) ** 2 / 1e6; // km²
    const sorted = [...comps.values()].filter((c) => c.cells * cellArea >= MIN_AREA).sort((a, b) => b.cells - a.cells);
    this.names = [];
    this.list = [];
    this.byId = new Map();
    for (const c of sorted) {
      let entry = named.get(c.id);
      if (!entry) {
        entry = { name: townName(t.biome.id, Math.round(c.x * 7) * 7919 + Math.round(c.z * 7), used) };
        used.add(entry.name);
      }
      entry.x = Math.round(c.x * 100) / 100;
      entry.z = Math.round(c.z * 100) / 100;
      this.names.push(entry);
      const town = { id: c.id, x: c.x, z: c.z, cx: c.cx, cz: c.cz, cells: c.cells, area: c.cells * cellArea, entry };
      this.list.push(town);
      this.byId.set(c.id, town);
    }
  }

  findNear(x, z) {
    const [gc, gr] = this.terrain.worldToGrid(x, z);
    const c0 = Math.round(gc / STEP);
    const r0 = Math.round(gr / STEP);
    for (let d = 0; d <= MATCH_RADIUS; d++) {
      for (let r = r0 - d; r <= r0 + d; r++) {
        for (let c = c0 - d; c <= c0 + d; c++) {
          if (r < 0 || c < 0 || r >= this.w || c >= this.w) continue;
          const id = this.labels[r * this.w + c];
          if (id) return id;
        }
      }
    }
    return 0;
  }

  toJSON() {
    return this.names.map(({ x, z, name }) => ({ x, z, name }));
  }

  /** Remplace les noms ; appeler update() une fois les couches du terrain en place. */
  fromJSON(arr) {
    this.names = structuredClone(arr ?? []);
  }

  snapshot() {
    return this.toJSON();
  }

  restore(s) {
    this.fromJSON(s);
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEA_FLOOR } from './terrain.js';
import { hash, part, makePath, pointAt, slicePoints, label } from './util.js';

/**
 * Trafic animé :
 * - véhicules sur le réseau routier : chaque ville desservie a un arrêt, et chaque véhicule
 *   enchaîne des trajets au plus court (Dijkstra sur le graphe des carrefours) vers une autre ville
 *   du même réseau ;
 * - bateaux entre chaque paire de ports situés sur des îles différentes,
 *   sur un trajet maritime calculé (Dijkstra sur une grille d'eau, puis lissage).
 * Vitesses accélérées (≈ x10) pour que le mouvement se voie à l'échelle de l'île.
 */

const CAR_SPEED = [2.2, 3.4];
const BOAT_SPEED = [1.6, 2.2];
const MAX_VEHICLES = 600;
const MAX_CARS_PER_NETWORK = 40;
const CAR_PAUSE = 0.6;
const MAX_BOATS = 120;
const MAX_SEA_ROUTES = 45;
const SEA_CELL = 2;
const SEA_MARGIN = 40;
const NAVIGABLE = -0.5; // profondeur minimale (unités) pour naviguer
const VEHICLE_COLORS = [0xd23c32, 0x2f62b5, 0xf2f2f2, 0xe8c547, 0x3a8a4a, 0x2a2a2a, 0x9aa4ad];
const BOAT_COLORS = [0xf2f2f2, 0x2f4f7a, 0xc8402f, 0x2a6a5a];

function vehicleGeometry() {
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.26, 0.08, 0.13), 0xffffff, { y: 0.06 }),
    part(new THREE.BoxGeometry(0.13, 0.06, 0.11), 0x55606a, { x: -0.02, y: 0.13 }),
  ]);
}

function boatGeometry() {
  const s = new THREE.Shape().moveTo(-0.28, -0.1).lineTo(0.14, -0.1).lineTo(0.32, 0).lineTo(0.14, 0.1).lineTo(-0.28, 0.1).closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 0.08, 0);
  return mergeGeometries([
    part(hull, 0xffffff),
    part(new THREE.BoxGeometry(0.16, 0.08, 0.14), 0xf4f1ea, { x: -0.08, y: 0.12 }),
    part(new THREE.BoxGeometry(0.08, 0.05, 0.1), 0xd8d2c4, { x: -0.1, y: 0.185 }),
  ]);
}

/** Tas binaire minimal (clé = coût). */
class Heap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(k, v) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const k = keys.pop();
    const v = vals.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= keys.length) break;
        if (c + 1 < keys.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

const _pt = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
const _eff = {};
const CALM = { car: 1, boat: 1, rough: 0, closed: false };
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();

export class Traffic {
  constructor(scene, terrain, roads, ports, towns) {
    this.terrain = terrain;
    this.towns = towns;
    this.roads = roads;
    this.ports = ports;
    this.agents = [];
    this.time = 0;
    this.stats = { vehicles: 0, boats: 0, held: 0, slowed: 0 };
    this.lightsOn = false;

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
    this.cars = new THREE.InstancedMesh(vehicleGeometry(), material, MAX_VEHICLES);
    this.boats = new THREE.InstancedMesh(boatGeometry(), material, MAX_BOATS);
    for (const m of [this.cars, this.boats]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      scene.add(m);
    }

    // Un point lumineux par véhicule (phares) et par bateau (feu de mât), visible la nuit.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_VEHICLES + MAX_BOATS) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.lights = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xfff1c8, size: 3, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.lights.frustumCulled = false;
    this.lights.visible = false;
    scene.add(this.lights);
  }

  // --- Calcul des itinéraires ---

  rebuild() {
    this.agents = [];
    this.cars.count = 0;
    this.boats.count = 0;
    let seed = 0;
    const color = new THREE.Color();

    this.stops = this.townStops();
    this.routeCache = new Map();
    const byNetwork = new Map();
    this.stops.forEach((stop, i) => {
      if (!byNetwork.has(stop.comp)) byNetwork.set(stop.comp, { stops: [], length: 0 });
      byNetwork.get(stop.comp).stops.push(i);
    });
    const { edges } = this.roads.network;
    for (const e of edges) {
      const group = byNetwork.get(this.components[e.a]);
      if (group) group.length += e.length;
    }
    for (const { stops, length } of byNetwork.values()) {
      if (stops.length < 2) continue;
      const n = Math.min(MAX_CARS_PER_NETWORK, Math.max(2, Math.round(length / 12)));
      for (let k = 0; k < n && this.cars.count < MAX_VEHICLES; k++, seed++) {
        const from = stops[Math.floor(hash(seed, 7, 41) * stops.length)];
        const to = this.nextStop(stops, from, hash(seed, 8, 41));
        const path = this.route(from, to);
        if (!path) continue;
        const index = this.cars.count++;
        this.cars.setColorAt(index, color.setHex(VEHICLE_COLORS[Math.floor(hash(seed, 1, 41) * VEHICLE_COLORS.length)]));
        this.agents.push({
          kind: 'car',
          index,
          path,
          stops,
          to,
          seed,
          trip: 0,
          s: hash(seed, 2, 41) * path.length,
          dir: 1,
          speed: CAR_SPEED[0] + (CAR_SPEED[1] - CAR_SPEED[0]) * hash(seed, 4, 41),
          pause: 0,
        });
      }
    }

    for (const path of this.seaRoutes()) {
      const n = path.length > 120 ? 2 : 1;
      for (let k = 0; k < n && this.boats.count < MAX_BOATS; k++, seed++) {
        const index = this.boats.count++;
        this.boats.setColorAt(index, color.setHex(BOAT_COLORS[Math.floor(hash(seed, 1, 42) * BOAT_COLORS.length)]));
        this.agents.push({
          kind: 'boat',
          index,
          path,
          s: k === 0 ? 0 : path.length,
          dir: k === 0 ? 1 : -1,
          speed: BOAT_SPEED[0] + (BOAT_SPEED[1] - BOAT_SPEED[0]) * hash(seed, 4, 42),
          pause: 1 + 3 * hash(seed, 5, 42),
          phase: hash(seed, 6, 42) * 10,
        });
      }
    }

    for (const m of [this.cars, this.boats]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.stats.vehicles = this.cars.count;
    this.stats.boats = this.boats.count;
    this.agents.forEach((a, i) => (a.light = i));
    this.lights.geometry.setDrawRange(0, this.agents.length);
    this.update(0);
  }

  /**
   * Arrêts : pour chaque ville (voir towns.js, à jour avant l'appel) et chaque réseau qui la
   * traverse, le point du réseau le plus proche du centre de la ville. Renvoie [{ edge, s, comp }].
   */
  townStops() {
    const { nodes, edges } = this.roads.network;
    // Réseaux = composantes connexes du graphe (union-find).
    const parent = nodes.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const e of edges) parent[find(e.a)] = find(e.b);
    this.components = nodes.map((_, i) => find(i));
    if (!edges.length) return [];

    const towns = this.towns;
    const best = new Map();
    const p = {};
    edges.forEach((e, ei) => {
      const comp = this.components[e.a];
      for (let s = 0; s <= e.length; s += 1) {
        pointAt(e.path, s, p);
        const town = towns.byId.get(towns.idAt(p.x, p.z));
        if (!town) continue;
        const d = Math.hypot(p.x - town.cx, p.z - town.cz);
        const key = `${town.id}/${comp}`;
        const cur = best.get(key);
        if (!cur || d < cur.d) best.set(key, { edge: ei, s, comp, d });
      }
    });
    return [...best.values()];
  }

  /** Arrêt suivant, tiré parmi `stops` hors arrêt courant. */
  nextStop(stops, current, r) {
    const others = stops.filter((i) => i !== current);
    return others[Math.floor(r * others.length)];
  }

  /** Chemin le plus court entre deux arrêts (mis en cache), ou null. */
  route(from, to) {
    const key = `${from}-${to}`;
    if (this.routeCache.has(key)) return this.routeCache.get(key);
    const { nodes, edges, adj } = this.roads.network;
    const A = this.stops[from];
    const B = this.stops[to];
    const ea = edges[A.edge];
    const eb = edges[B.edge];

    const dist = new Float64Array(nodes.length).fill(Infinity);
    const prevEdge = new Int32Array(nodes.length).fill(-1);
    const prevNode = new Int32Array(nodes.length).fill(-1);
    const heap = new Heap();
    const seed = (n, d) => {
      if (d < dist[n]) {
        dist[n] = d;
        heap.push(d, n);
      }
    };
    seed(ea.a, A.s);
    seed(ea.b, ea.length - A.s);
    while (heap.size) {
      const n = heap.pop();
      for (const { edge, to: m } of adj[n]) {
        const d = dist[n] + edges[edge].length;
        if (d < dist[m]) {
          dist[m] = d;
          prevEdge[m] = edge;
          prevNode[m] = n;
          heap.push(d, m);
        }
      }
    }

    // Arrivée par l'un ou l'autre bout de l'arête de B (ou directement, si même arête).
    const viaA = dist[eb.a] + B.s;
    const viaB = dist[eb.b] + eb.length - B.s;
    const direct = A.edge === B.edge ? Math.abs(A.s - B.s) : Infinity;
    let pts;
    if (direct <= Math.min(viaA, viaB)) {
      pts = slicePoints(ea.path, A.s, B.s);
    } else if (Number.isFinite(Math.min(viaA, viaB))) {
      const endAtA = viaA <= viaB;
      const chain = [];
      let n = endAtA ? eb.a : eb.b;
      while (prevEdge[n] >= 0) {
        chain.push({ edge: prevEdge[n], from: prevNode[n] });
        n = prevNode[n];
      }
      chain.reverse();
      // n = nœud de départ : bout de l'arête de A par lequel on la quitte.
      const leaveAtA = n === ea.a && (n !== ea.b || A.s <= ea.length - A.s);
      pts = slicePoints(ea.path, A.s, leaveAtA ? 0 : ea.length);
      for (const { edge, from: u } of chain) {
        const e = edges[edge];
        if (e.a === u) slicePoints(e.path, 0, e.length, pts);
        else slicePoints(e.path, e.length, 0, pts);
      }
      slicePoints(eb.path, endAtA ? 0 : eb.length, B.s, pts);
    }
    const path = pts && pts.length >= 2 ? makePath(pts) : null;
    this.routeCache.set(key, path);
    return path;
  }

  /** Itinéraires maritimes entre ports d'îles différentes. */
  seaRoutes() {
    const t = this.terrain;
    const ports = this.ports.list;
    if (ports.length < 2) return [];

    // Îles = composantes connexes des terres émergées.
    const islands = label(t.res, t.res, (i) => t.heights[i] > 0);
    const islandOf = (p) => {
      const [gc, gr] = t.worldToGrid(p.x, p.z);
      for (let d = 0; d <= 3; d++) {
        for (let r = Math.round(gr) - d; r <= Math.round(gr) + d; r++) {
          for (let c = Math.round(gc) - d; c <= Math.round(gc) + d; c++) {
            if (r >= 0 && c >= 0 && r < t.res && c < t.res && islands[r * t.res + c]) return islands[r * t.res + c];
          }
        }
      }
      return 0;
    };
    const ids = ports.map(islandOf);

    // Grille de navigation (déborde de la zone pour contourner les îles près du bord).
    const extent = t.size / 2 + SEA_MARGIN;
    const w = Math.ceil((2 * extent) / SEA_CELL) + 1;
    const toWorld = (i) => [-extent + (i % w) * SEA_CELL, -extent + ((i / w) | 0) * SEA_CELL];
    const depthAt = (x, z) => (t.inside(x, z) ? t.heightAt(x, z) : SEA_FLOOR);
    const water = new Uint8Array(w * w);
    for (let i = 0; i < w * w; i++) {
      const [x, z] = toWorld(i);
      water[i] = depthAt(x, z) < NAVIGABLE ? 1 : 0;
    }
    const nodeOf = (x, z) => {
      const c0 = Math.round((x + extent) / SEA_CELL);
      const r0 = Math.round((z + extent) / SEA_CELL);
      let best = -1;
      let bestD = Infinity;
      for (let r = r0 - 3; r <= r0 + 3; r++) {
        for (let c = c0 - 3; c <= c0 + 3; c++) {
          if (r < 0 || c < 0 || r >= w || c >= w || !water[r * w + c]) continue;
          const d = (c - c0) ** 2 + (r - r0) ** 2;
          if (d < bestD) {
            bestD = d;
            best = r * w + c;
          }
        }
      }
      return best;
    };
    const nodes = ports.map((p) => nodeOf(p.dx, p.dz));
    const clear = (ax, az, bx, bz) => {
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5);
      for (let k = 1; k < n; k++) if (depthAt(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n) >= -0.3) return false;
      return true;
    };

    const routes = [];
    const dist = new Float32Array(w * w);
    const prev = new Int32Array(w * w);
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

    for (let a = 0; a < ports.length && routes.length < MAX_SEA_ROUTES; a++) {
      const targets = [];
      for (let b = a + 1; b < ports.length; b++) if (ids[a] && ids[b] && ids[a] !== ids[b] && nodes[a] >= 0 && nodes[b] >= 0) targets.push(b);
      if (!targets.length || nodes[a] < 0) continue;

      // Dijkstra depuis le port a jusqu'à atteindre tous les ports cibles.
      dist.fill(Infinity);
      prev.fill(-1);
      const heap = new Heap();
      dist[nodes[a]] = 0;
      heap.push(0, nodes[a]);
      let remaining = new Set(targets.map((b) => nodes[b]));
      while (heap.size && remaining.size) {
        const i = heap.pop();
        remaining.delete(i);
        const x = i % w;
        const y = (i / w) | 0;
        for (const [ox, oy, cost] of DIRS) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= w) continue;
          const j = ny * w + nx;
          // Pas de diagonale qui coupe un coin de terre.
          if (!water[j] || (ox && oy && (!water[y * w + nx] || !water[ny * w + x]))) continue;
          const d = dist[i] + cost;
          if (d < dist[j]) {
            dist[j] = d;
            prev[j] = i;
            heap.push(d, j);
          }
        }
      }

      for (const b of targets) {
        if (!Number.isFinite(dist[nodes[b]]) || routes.length >= MAX_SEA_ROUTES) continue;
        const cells = [];
        for (let i = nodes[b]; i >= 0; i = prev[i]) cells.push(toWorld(i));
        cells.reverse();
        const raw = [[ports[a].dx, ports[a].dz], ...cells, [ports[b].dx, ports[b].dz]];
        // Simplification par visibilité, puis lissage.
        const simple = [raw[0]];
        let k = 0;
        while (k < raw.length - 1) {
          let j = raw.length - 1;
          while (j > k + 1 && !clear(raw[k][0], raw[k][1], raw[j][0], raw[j][1])) j--;
          simple.push(raw[j]);
          k = j;
        }
        const curve = new THREE.CatmullRomCurve3(simple.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
        const pts = curve.getSpacedPoints(Math.max(2, Math.ceil(curve.getLength() / 0.5)));
        routes.push(makePath(pts.map((p) => ({ x: p.x, y: 0, z: p.z }))));
      }
    }
    return routes;
  }

  // --- Animation ---

  /**
   * Avance les véhicules et les bateaux. `weather` (facultatif) ralentit chacun selon la météo à sa
   * position ; un bateau à quai n'appareille pas tant que son port est sous une tempête.
   */
  update(dt, weather = null) {
    this.time += dt;
    let held = 0;
    let slowed = 0;
    for (const a of this.agents) {
      const eff = weather && a.x !== undefined ? weather.effectAt(a.x, a.z, _eff) : CALM;
      if (a.pause > 0) {
        a.pause -= dt;
        if (a.kind === 'boat' && eff.closed) {
          a.pause = Math.max(a.pause, 0.5);
          held++;
        }
      } else if (a.kind === 'car') {
        a.s += a.speed * eff.car * dt;
        if (eff.car < 0.9) slowed++;
        if (a.s >= a.path.length) {
          // Arrivé en ville : petite pause, puis trajet vers une autre ville du réseau.
          const next = this.nextStop(a.stops, a.to, hash(a.seed, ++a.trip, 43));
          const path = this.route(a.to, next);
          if (path) {
            a.path = path;
            a.to = next;
            a.s = 0;
          } else {
            a.s = a.path.length;
          }
          a.pause = CAR_PAUSE;
        }
      } else {
        a.s += a.dir * a.speed * eff.boat * dt;
        if (eff.boat < 0.9) slowed++;
        if (a.s >= a.path.length || a.s <= 0) {
          a.s = Math.min(a.path.length, Math.max(0, a.s));
          a.dir = -a.dir;
          a.pause = 3;
        }
      }
      pointAt(a.path, a.s, _pt);
      a.x = _pt.x;
      a.z = _pt.z;
      const fx = _pt.dx * a.dir;
      const fz = _pt.dz * a.dir;
      if (a.kind === 'car') {
        // Conduite à droite : décalage latéral (la droite de (fx, fz) est (-fz, fx)).
        _p.set(_pt.x - fz * 0.09, _pt.y, _pt.z + fx * 0.09);
        _q.setFromEuler(_e.set(0, Math.atan2(-fz, fx), 0));
        _m.compose(_p, _q, _s);
        this.cars.setMatrixAt(a.index, _m);
        if (this.lightsOn) this.setLight(a, _p.x + fx * 0.15, _p.y + 0.07, _p.z + fz * 0.15);
      } else {
        // La houle grossit avec la mer agitée.
        const t = this.time + a.phase;
        const swell = 1 + 4 * eff.rough;
        _p.set(_pt.x, 0.02 + Math.sin(t * 1.7) * 0.02 * swell, _pt.z);
        _q.setFromEuler(_e.set(Math.sin(t * 1.3) * 0.05 * swell, Math.atan2(-fz, fx), Math.sin(t * 1.1) * 0.03 * swell, 'YXZ'));
        _m.compose(_p, _q, _s);
        this.boats.setMatrixAt(a.index, _m);
        if (this.lightsOn) this.setLight(a, _p.x, _p.y + 0.3, _p.z);
      }
    }
    this.cars.instanceMatrix.needsUpdate = true;
    this.boats.instanceMatrix.needsUpdate = true;
    if (this.lightsOn) this.lights.geometry.attributes.position.needsUpdate = true;
    this.stats.held = held;
    this.stats.slowed = slowed;
  }

  setLight(a, x, y, z) {
    this.lights.geometry.attributes.position.setXYZ(a.light, x, y, z);
  }

  /** Phares et feux de mât, selon le niveau d'éclairage artificiel (0..1). */
  setLightsLevel(level) {
    this.lightsOn = level > 0.01;
    this.lights.visible = this.lightsOn;
    this.lights.material.opacity = level;
  }

}

import * as THREE from 'three';
import { makePath, pointAt, slicePoints } from './util.js';

const ROAD_WIDTH = 0.35;
const SAMPLE_STEP = 0.4;
const LIFT = 0.07;
const DECK_Y = 0.6; // tablier des ponts au-dessus de l'eau (≈ 30 m)
const RAMP_SLOPE = 0.12; // pente des rampes d'accès (unités de hauteur par unité de longueur)
const DECK_THICKNESS = 0.08;
const PARAPET = 0.06;
const PIER_SPACING = 3;
const PIER_WIDTH = 0.14;
const SNAP_DISTANCE = 2.5; // accroche sur l'extrémité d'une route
const SNAP_ROAD = 1.5; // accroche sur le tracé d'une route (carrefour en T)
const PICK_DISTANCE = 1.5;
const JOIN_TOLERANCE = 0.3; // extrémité considérée comme posée sur une autre route
const NODE_MERGE = 0.6; // points de coupe fusionnés en un même carrefour
const GRID_CELL = 2; // grille d'accélération pour la recherche des croisements

/**
 * Routes : polylignes de points de contrôle (x, z), lissées en Catmull-Rom,
 * drapées sur le relief. Au-dessus de l'eau, elles passent sur un pont (tablier, piles, garde-corps)
 * auquel on accède par des rampes depuis la côte.
 *
 * Le réseau (`network`) est déduit de la géométrie : chaque croisement entre deux tracés et chaque
 * extrémité posée sur une autre route devient un carrefour. Les tronçons entre carrefours sont les arêtes.
 */
export class Roads {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.list = []; // [{ points: [{ x, z }] }]
    this.paths = []; // chemins échantillonnés, un par route (voir makePath)
    this.network = { nodes: [], edges: [], adj: [] };

    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Ouvrages d'art : tranche du tablier, garde-corps et piles.
    this.bridges = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.85, flatShading: true, side: THREE.DoubleSide }),
    );
    this.bridges.castShadow = true;
    this.bridges.receiveShadow = true;
    this.bridges.frustumCulled = false;
    scene.add(this.bridges);

    // Tracé en cours.
    this.draft = [];
    this.extend = null; // { index, atStart } si on prolonge une route existante
    this.preview = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3)),
      new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }),
    );
    this.preview.renderOrder = 1000;
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    scene.add(this.preview);

    // Tronçon visé par Maj+clic (suppression).
    this.highlight = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0xff5a4f, depthTest: false, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    );
    this.highlightIndex = -1;
    this.highlight.renderOrder = 1000;
    this.highlight.frustumCulled = false;
    this.highlight.visible = false;
    scene.add(this.highlight);

    // Repère d'accroche (extrémité ou carrefour) sous le curseur.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }),
    );
    this.marker.renderOrder = 1001;
    this.marker.visible = false;
    scene.add(this.marker);
  }

  setColor(hex) {
    this.mesh.material.color.setHex(hex);
  }

  /** Hauteur de chaussée posée sur le sol (jamais sous le niveau de la mer). */
  surfaceY(x, z) {
    return Math.max(this.terrain.heightAt(x, z), 0) + LIFT;
  }

  /**
   * Échantillonne une suite de points de contrôle en chemin drapé. Les portions au-dessus de l'eau
   * montent au niveau du tablier, avec une rampe de chaque côté.
   */
  sample(points) {
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
    const n = Math.max(2, Math.ceil(curve.getLength() / SAMPLE_STEP));
    const pts = curve.getSpacedPoints(n);
    // Distance (le long du tracé) à l'eau la plus proche, en deux passes.
    const s = new Float32Array(pts.length);
    for (let k = 1; k < pts.length; k++) s[k] = s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    const toWater = new Float32Array(pts.length).fill(Infinity);
    pts.forEach((p, k) => {
      p.y = this.surfaceY(p.x, p.z);
      if (this.terrain.heightAt(p.x, p.z) < 0.05) toWater[k] = 0;
    });
    for (let k = 1; k < pts.length; k++) toWater[k] = Math.min(toWater[k], toWater[k - 1] + s[k] - s[k - 1]);
    for (let k = pts.length - 2; k >= 0; k--) toWater[k] = Math.min(toWater[k], toWater[k + 1] + s[k + 1] - s[k]);
    for (let k = 0; k < pts.length; k++) pts[k].y = Math.max(pts[k].y, DECK_Y + LIFT - toWater[k] * RAMP_SLOPE);
    return makePath(pts);
  }

  /** La chaussée est-elle au-dessus du sol en (x, z), à la hauteur y (pont ou rampe) ? */
  elevated(x, z, y) {
    return y > this.surfaceY(x, z) + 0.02;
  }

  rebuild() {
    this.list = this.list.filter((r) => r.points.length >= 2);
    this.paths = this.list.map((r) => this.sample(r.points)); // alignés sur this.list
    const positions = [];
    const indices = [];
    const half = ROAD_WIDTH / 2;
    for (const { xyz, count } of this.paths) {
      const base = positions.length / 3;
      for (let k = 0; k < count; k++) {
        const a = Math.max(k - 1, 0) * 3;
        const b = Math.min(k + 1, count - 1) * 3;
        let tx = xyz[b] - xyz[a];
        let tz = xyz[b + 2] - xyz[a + 2];
        const len = Math.hypot(tx, tz) || 1;
        tx /= len;
        tz /= len;
        const x = xyz[k * 3];
        const z = xyz[k * 3 + 2];
        // Gauche puis droite (normale = (-tz, tx) pointe à droite).
        const lx = x - -tz * half;
        const lz = z - tx * half;
        const rx = x + -tz * half;
        const rz = z + tx * half;
        const y = xyz[k * 3 + 1];
        if (this.elevated(x, z, y)) positions.push(lx, y, lz, rx, y, rz);
        else positions.push(lx, this.surfaceY(lx, lz), lz, rx, this.surfaceY(rx, rz), rz);
        if (k < count - 1) {
          const l0 = base + k * 2;
          indices.push(l0 + 1, l0 + 2, l0, l0 + 1, l0 + 3, l0 + 2);
        }
      }
    }
    // Carrefours : une pastille couvre le raccord des rubans.
    this.network = this.buildNetwork();
    const SIDES = 14;
    const radius = ROAD_WIDTH * 0.8;
    for (const node of this.network.nodes) {
      if (node.degree < 3) continue;
      const base = positions.length / 3;
      positions.push(node.x, node.y + 0.004, node.z);
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        const x = node.x + Math.cos(a) * radius;
        const z = node.z + Math.sin(a) * radius;
        positions.push(x, (this.elevated(node.x, node.z, node.y) ? node.y : Math.max(this.surfaceY(x, z), node.y)) + 0.004, z);
        indices.push(base, base + 1 + ((k + 1) % SIDES), base + 1 + k);
      }
    }
    const g = this.mesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    this.buildBridges();
  }

  /** Tablier (tranche et sous-face), garde-corps et piles des portions surélevées. */
  buildBridges() {
    const pos = [];
    const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    const half = ROAD_WIDTH / 2;
    const p = {};
    for (const path of this.paths) {
      const { xyz, count } = path;
      const side = (k, sign) => {
        const a = Math.max(k - 1, 0) * 3;
        const b = Math.min(k + 1, count - 1) * 3;
        const tx = xyz[b] - xyz[a];
        const tz = xyz[b + 2] - xyz[a + 2];
        const len = Math.hypot(tx, tz) || 1;
        return [xyz[k * 3] + (sign * -tz * half) / len, xyz[k * 3 + 1], xyz[k * 3 + 2] + (sign * tx * half) / len];
      };
      const up = (v, dy) => [v[0], v[1] + dy, v[2]];
      for (let k = 0; k < count - 1; k++) {
        const on = (i) => this.elevated(xyz[i * 3], xyz[i * 3 + 2], xyz[i * 3 + 1]);
        if (!on(k) && !on(k + 1)) continue;
        const l0 = side(k, -1);
        const l1 = side(k + 1, -1);
        const r0 = side(k, 1);
        const r1 = side(k + 1, 1);
        for (const [a, b] of [[l0, l1], [r0, r1]]) {
          quad(up(a, -DECK_THICKNESS), up(b, -DECK_THICKNESS), b, a); // tranche
          quad(a, b, up(b, PARAPET), up(a, PARAPET)); // garde-corps
        }
        quad(up(l0, -DECK_THICKNESS), up(r0, -DECK_THICKNESS), up(r1, -DECK_THICKNESS), up(l1, -DECK_THICKNESS)); // sous-face
      }
      // Piles régulières, descendant jusqu'au fond (ou au sol des rampes).
      for (let s = PIER_SPACING / 2; s < path.length; s += PIER_SPACING) {
        pointAt(path, s, p);
        const ground = this.terrain.heightAt(p.x, p.z);
        const top = p.y - DECK_THICKNESS;
        if (top - Math.max(ground, 0) < 0.15) continue;
        const w = PIER_WIDTH / 2;
        // Section allongée en travers de la route.
        const ax = -p.dz * half * 0.8, az = p.dx * half * 0.8;
        const bx = p.dx * w, bz = p.dz * w;
        const c = [
          [p.x - ax - bx, p.z - az - bz], [p.x + ax - bx, p.z + az - bz],
          [p.x + ax + bx, p.z + az + bz], [p.x - ax + bx, p.z - az + bz],
        ];
        for (let i = 0; i < 4; i++) {
          const [x0, z0] = c[i];
          const [x1, z1] = c[(i + 1) % 4];
          quad([x0, ground, z0], [x1, ground, z1], [x1, top, z1], [x0, top, z0]);
        }
      }
    }
    const g = this.bridges.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
  }

  /** Point le plus proche sur les tracés (hors route `skip`), à moins de `maxD`. */
  nearestOnPaths(x, z, maxD, skip = -1) {
    let best = null;
    let bestD = maxD;
    this.paths.forEach((path, pi) => {
      if (pi === skip) return;
      const { xyz, cum, count } = path;
      for (let k = 0; k < count - 1; k++) {
        const ax = xyz[k * 3];
        const az = xyz[k * 3 + 2];
        const vx = xyz[k * 3 + 3] - ax;
        const vz = xyz[k * 3 + 5] - az;
        const l2 = vx * vx + vz * vz || 1;
        const t = Math.min(1, Math.max(0, ((x - ax) * vx + (z - az) * vz) / l2));
        const px = ax + vx * t;
        const pz = az + vz * t;
        const d = Math.hypot(px - x, pz - z);
        if (d < bestD) {
          bestD = d;
          best = { path: pi, s: cum[k] + (cum[k + 1] - cum[k]) * t, x: px, z: pz, d };
        }
      }
    });
    return best;
  }

  /** Graphe du réseau : nœuds (extrémités, carrefours) et arêtes (tronçons échantillonnés). */
  buildNetwork() {
    const paths = this.paths;
    const cuts = paths.map((p) => [0, p.length]);

    // Croisements : segments indexés dans une grille, testés deux à deux par case.
    const grid = new Map();
    paths.forEach(({ xyz, count }, pi) => {
      for (let k = 0; k < count - 1; k++) {
        const x0 = Math.floor(Math.min(xyz[k * 3], xyz[k * 3 + 3]) / GRID_CELL);
        const x1 = Math.floor(Math.max(xyz[k * 3], xyz[k * 3 + 3]) / GRID_CELL);
        const z0 = Math.floor(Math.min(xyz[k * 3 + 2], xyz[k * 3 + 5]) / GRID_CELL);
        const z1 = Math.floor(Math.max(xyz[k * 3 + 2], xyz[k * 3 + 5]) / GRID_CELL);
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            const key = gx * 100003 + gz;
            let list = grid.get(key);
            if (!list) grid.set(key, (list = []));
            list.push(pi, k);
          }
        }
      }
    });
    const seen = new Set();
    for (const list of grid.values()) {
      for (let i = 0; i < list.length; i += 2) {
        for (let j = i + 2; j < list.length; j += 2) {
          let [pa, ka, pb, kb] = [list[i], list[i + 1], list[j], list[j + 1]];
          if (pa === pb && Math.abs(ka - kb) <= 1) continue;
          if (pa > pb || (pa === pb && ka > kb)) [pa, ka, pb, kb] = [pb, kb, pa, ka];
          const key = `${pa},${ka},${pb},${kb}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const A = paths[pa];
          const B = paths[pb];
          const ax = A.xyz[ka * 3], az = A.xyz[ka * 3 + 2];
          const ux = A.xyz[ka * 3 + 3] - ax, uz = A.xyz[ka * 3 + 5] - az;
          const bx = B.xyz[kb * 3], bz = B.xyz[kb * 3 + 2];
          const vx = B.xyz[kb * 3 + 3] - bx, vz = B.xyz[kb * 3 + 5] - bz;
          const den = ux * vz - uz * vx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((bx - ax) * vz - (bz - az) * vx) / den;
          const u = ((bx - ax) * uz - (bz - az) * ux) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          cuts[pa].push(A.cum[ka] + (A.cum[ka + 1] - A.cum[ka]) * t);
          cuts[pb].push(B.cum[kb] + (B.cum[kb + 1] - B.cum[kb]) * u);
        }
      }
    }

    // Carrefours en T : extrémité posée sur le tracé d'une autre route.
    paths.forEach((path, pi) => {
      for (const s of [0, path.length]) {
        const p = pointAt(path, s, {});
        const hit = this.nearestOnPaths(p.x, p.z, JOIN_TOLERANCE, pi);
        if (hit) cuts[hit.path].push(hit.s);
      }
    });

    // Nœuds (points de coupe fusionnés) et arêtes (tronçons entre coupes successives).
    const nodes = [];
    const edges = [];
    const nodeAt = (x, y, z) => {
      for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i].x - x, nodes[i].z - z) < NODE_MERGE) return i;
      nodes.push({ x, y, z, degree: 0 });
      return nodes.length - 1;
    };
    const p = {};
    paths.forEach((path, pi) => {
      const sorted = cuts[pi].sort((a, b) => a - b);
      const kept = [0];
      for (const s of sorted) if (s - kept[kept.length - 1] > JOIN_TOLERANCE && path.length - s > JOIN_TOLERANCE) kept.push(s);
      kept.push(path.length);
      let prev = nodeAt(path.xyz[0], path.xyz[1], path.xyz[2]);
      for (let k = 1; k < kept.length; k++) {
        pointAt(path, kept[k], p);
        const node = nodeAt(p.x, p.y, p.z);
        const edgePath = makePath(slicePoints(path, kept[k - 1], kept[k]));
        edges.push({ a: prev, b: node, path: edgePath, length: edgePath.length, road: pi, s0: kept[k - 1], s1: kept[k] });
        nodes[prev].degree++;
        nodes[node].degree++;
        prev = node;
      }
    });
    const adj = nodes.map(() => []);
    edges.forEach((e, i) => {
      adj[e.a].push({ edge: i, to: e.b });
      if (e.b !== e.a) adj[e.b].push({ edge: i, to: e.a });
    });
    return { nodes, edges, adj };
  }

  /** Marque dans `mask` (grille du terrain) les cases couvertes par les routes. */
  rasterize(mask) {
    const { res } = this.terrain;
    for (const { xyz, count } of this.paths) {
      for (let k = 0; k < count; k++) {
        const [gc, gr] = this.terrain.worldToGrid(xyz[k * 3], xyz[k * 3 + 2]);
        const c = Math.round(gc);
        const r = Math.round(gr);
        for (let rr = r - 1; rr <= r + 1; rr++) {
          for (let cc = c - 1; cc <= c + 1; cc++) {
            if (rr >= 0 && cc >= 0 && rr < res && cc < res) mask[rr * res + cc] = 1;
          }
        }
      }
    }
  }

  remove(index) {
    this.list.splice(index, 1);
    this.rebuild();
  }

  /** Index du tronçon (arête du réseau) le plus proche de (x, z), ou -1. */
  pickEdge(x, z) {
    let best = -1;
    let bestD = PICK_DISTANCE;
    this.network.edges.forEach(({ path }, i) => {
      for (let k = 0; k < path.count; k++) {
        const d = Math.hypot(path.xyz[k * 3] - x, path.xyz[k * 3 + 2] - z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });
    return best;
  }

  /**
   * Supprime un tronçon : sa route est coupée en deux (ce qui précède et ce qui suit le tronçon).
   * Les morceaux restants sont redéfinis par des points de contrôle pris sur le tracé lissé.
   */
  removeEdge(index) {
    const edge = this.network.edges[index];
    if (!edge) return;
    const path = this.paths[edge.road];
    const parts = [];
    if (edge.s0 > JOIN_TOLERANCE) parts.push({ points: this.controlPoints(path, 0, edge.s0) });
    if (path.length - edge.s1 > JOIN_TOLERANCE) parts.push({ points: this.controlPoints(path, edge.s1, path.length) });
    this.list.splice(edge.road, 1, ...parts);
    this.rebuild();
  }

  /** Points de contrôle (≈ toutes les 1,5 unités) reproduisant le tracé entre s0 et s1. */
  controlPoints(path, s0, s1) {
    const pts = slicePoints(path, s0, s1);
    const out = [pts[0]];
    let run = 0;
    for (let k = 1; k < pts.length - 1; k++) {
      run += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      if (run >= 1.5) {
        out.push(pts[k]);
        run = 0;
      }
    }
    const last = pts[pts.length - 1];
    if (out.length > 1 && Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].z - last.z) < 0.5) out.pop();
    out.push(last);
    return out.map((p) => ({ x: p.x, z: p.z }));
  }

  /** Surligne le tronçon sous le curseur (null pour masquer) ; renvoie son index ou -1. */
  updateHighlight(cursor) {
    const index = cursor ? this.pickEdge(cursor.x, cursor.z) : -1;
    this.highlight.visible = index >= 0;
    if (index < 0) return -1;
    if (index === this.highlightIndex && this.highlightNetwork === this.network) return index;
    this.highlightIndex = index;
    this.highlightNetwork = this.network;
    // Ruban un peu plus large que la chaussée.
    const { xyz, count } = this.network.edges[index].path;
    const half = ROAD_WIDTH * 0.75;
    const positions = [];
    const indices = [];
    for (let k = 0; k < count; k++) {
      const a = Math.max(k - 1, 0) * 3;
      const b = Math.min(k + 1, count - 1) * 3;
      const tx = xyz[b] - xyz[a];
      const tz = xyz[b + 2] - xyz[a + 2];
      const len = Math.hypot(tx, tz) || 1;
      const nx = (-tz / len) * half;
      const nz = (tx / len) * half;
      const y = xyz[k * 3 + 1] + 0.05;
      positions.push(xyz[k * 3] - nx, y, xyz[k * 3 + 2] - nz, xyz[k * 3] + nx, y, xyz[k * 3 + 2] + nz);
      if (k < count - 1) indices.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    }
    const g = this.highlight.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    return index;
  }

  endpointNear(x, z) {
    for (let i = 0; i < this.list.length; i++) {
      const pts = this.list[i].points;
      if (Math.hypot(pts[0].x - x, pts[0].z - z) < SNAP_DISTANCE) return { index: i, atStart: true, point: pts[0] };
      const last = pts[pts.length - 1];
      if (Math.hypot(last.x - x, last.z - z) < SNAP_DISTANCE) return { index: i, atStart: false, point: last };
    }
    return null;
  }

  // --- Tracé ---

  /** Accroche un point sur une extrémité, sinon sur le tracé d'une route existante. */
  snap(p) {
    const end = this.endpointNear(p.x, p.z);
    if (end) return { x: end.point.x, z: end.point.z, snapped: true };
    const on = this.nearestOnPaths(p.x, p.z, SNAP_ROAD);
    if (on) return { x: on.x, z: on.z, snapped: true };
    return { x: p.x, z: p.z, snapped: false };
  }

  addDraftPoint(hit) {
    const p = this.snap(hit);
    if (!this.draft.length) {
      // Commencer près d'une extrémité prolonge la route existante.
      this.extend = this.endpointNear(p.x, p.z);
      if (this.extend) {
        this.draft.push({ ...this.extend.point });
        return;
      }
    }
    const last = this.draft[this.draft.length - 1];
    if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.5) return;
    this.draft.push({ x: p.x, z: p.z });
  }

  removeLastDraft() {
    this.draft.pop();
    if (!this.draft.length) this.extend = null;
  }

  cancelDraft() {
    this.draft = [];
    this.extend = null;
    this.preview.visible = false;
    this.marker.visible = false;
    this.highlight.visible = false;
  }

  /** Valide le tracé ; renvoie true si une route a été créée ou prolongée. */
  commitDraft() {
    const pts = this.draft;
    const ok = pts.length >= 2;
    if (ok) {
      if (this.extend) {
        const road = this.list[this.extend.index];
        const added = pts.slice(1);
        road.points = this.extend.atStart ? [...added.reverse(), ...road.points] : [...road.points, ...added];
      } else {
        this.list.push({ points: pts });
      }
      this.rebuild();
    }
    this.cancelDraft();
    return ok;
  }

  /** Met à jour l'aperçu du tracé (et le repère d'accroche) ; renvoie sa longueur (unités), ou 0. */
  updatePreview(cursor) {
    const snapped = cursor ? this.snap(cursor) : null;
    this.marker.visible = !!snapped?.snapped;
    if (this.marker.visible) this.marker.position.set(snapped.x, Math.max(this.surfaceY(snapped.x, snapped.z), DECK_Y) + 0.05, snapped.z);
    const pts = snapped ? [...this.draft, snapped] : this.draft;
    const path = pts.length >= 2 ? this.sample(pts) : null;
    this.preview.visible = !!path;
    if (!path) return 0;
    const pos = this.preview.geometry.attributes.position;
    const n = Math.min(path.count, pos.count);
    for (let k = 0; k < n; k++) pos.setXYZ(k, path.xyz[k * 3], path.xyz[k * 3 + 1] + 0.05, path.xyz[k * 3 + 2]);
    pos.needsUpdate = true;
    this.preview.geometry.setDrawRange(0, n);
    return path.length;
  }

  // --- Persistance / historique ---

  toJSON() {
    return this.list.map((r) => r.points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100]));
  }

  fromJSON(arr) {
    this.list = (arr ?? []).map((pts) => ({ points: pts.map(([x, z]) => ({ x, z })) }));
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

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash, part } from './util.js';

/**
 * Objets générés à partir des zones peintes : arbres (forêt) et bâtiments (ville).
 * Tout est procédural et déterministe (hash par point de grille) : repeindre une zone
 * ne fait pas « sauter » les objets existants.
 * Les tailles sont stylisées (environ x2–x3 par rapport au réel) pour rester lisibles.
 * `blockers` (Uint8Array à la résolution du terrain) marque les cases occupées par les routes et ports.
 */

const TREE_SPACING = 0.9;
const TOWN_SPACING = 0.75;
const TOWN_BLOCK = 16; // taille d'un quartier (unités), chacun avec sa propre orientation
const MAX_TREES = 80000; // par essence
const MAX_BUILDINGS = 40000;

// --- Géométries ---

const trunk = (h, r, hex = 0x6b4a32) => part(new THREE.CylinderGeometry(r * 0.7, r, h, 5), hex, { y: h / 2 });

const SPECIES = {
  deciduous: () => [trunk(0.3, 0.05), part(new THREE.IcosahedronGeometry(0.32, 0), 0x4f8a3a, { y: 0.55 })],
  conifer: () => [trunk(0.18, 0.05), part(new THREE.ConeGeometry(0.28, 0.75, 6), 0x2f5e34, { y: 0.18 + 0.375 })],
  spruce: () => [
    trunk(0.15, 0.04),
    part(new THREE.ConeGeometry(0.24, 0.45, 6), 0x24452c, { y: 0.35 }),
    part(new THREE.ConeGeometry(0.18, 0.4, 6), 0x24452c, { y: 0.6 }),
    part(new THREE.ConeGeometry(0.11, 0.32, 6), 0x24452c, { y: 0.85 }),
  ],
  palm: () => [
    part(new THREE.CylinderGeometry(0.025, 0.04, 0.85, 5), 0x8a6a48, { y: 0.42, rz: 0.12, x: -0.05 }),
    part(new THREE.ConeGeometry(0.42, 0.14, 7), 0x4f9a3a, { y: 0.86, x: -0.1 }),
  ],
  broadleaf: () => [trunk(0.45, 0.06), part(new THREE.DodecahedronGeometry(0.42, 0), 0x2f7d36, { y: 0.72, sy: 0.7 })],
  birch: () => [trunk(0.28, 0.03, 0xd9d4c8), part(new THREE.IcosahedronGeometry(0.18, 0), 0x8fa64a, { y: 0.4 })],
  olive: () => [trunk(0.2, 0.05, 0x6b5a45), part(new THREE.IcosahedronGeometry(0.3, 0), 0x7d8a5a, { y: 0.32, sy: 0.6 })],
  pine: () => [trunk(0.55, 0.04, 0x7a5a3a), part(new THREE.IcosahedronGeometry(0.34, 0), 0x4d6b35, { y: 0.66, sy: 0.4 })],
};

function gableRoof() {
  // Base 1x1 en y=0, faîtage selon x en y=1.
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5];
  const E = [-0.5, 1, 0], F = [0.5, 1, 0];
  const tris = [D, C, F, D, F, E, B, A, E, B, E, F, A, D, E, C, B, F];
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

const BUILDING_STYLES = {
  gable: {
    walls: () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    roof: gableRoof,
    roofHeight: 0.45, // relatif à la largeur
  },
  flat: {
    walls: () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    roof: () => new THREE.BoxGeometry(1.08, 1, 1.08).translate(0, 0.5, 0),
    roofHeight: 0.08,
  },
  hut: {
    walls: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8).translate(0, 0.5, 0),
    roof: () => new THREE.ConeGeometry(0.68, 1, 8).translate(0, 0.5, 0),
    roofHeight: 0.8,
  },
};

// --- Gestion des InstancedMesh ---

const treeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
const buildingMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8 });

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

const MAX_WINDOWS = 3; // en moyenne par bâtiment, tours comprises

export class Props {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = new Map();
    this.dirty = true;
    this.lastRegen = 0;
    this.stats = { trees: 0, buildings: 0 };
    this.blockers = null;

    // Fenêtres éclairées la nuit : un point lumineux sur une façade de chaque maison (plusieurs pour les tours).
    this.windowPositions = new Float32Array(MAX_BUILDINGS * MAX_WINDOWS * 3);
    this.windowCount = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.windowPositions, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.windows = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xffc56b, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.windows.frustumCulled = false;
    this.windows.visible = false;
    scene.add(this.windows);
  }

  /** Niveau d'éclairage artificiel (0 = jour, 1 = pleine nuit). */
  setLightsLevel(level) {
    this.windows.material.opacity = level;
    this.windows.visible = level > 0.01;
  }

  addWindow(x, y, z) {
    if (this.windowCount >= MAX_BUILDINGS * MAX_WINDOWS) return;
    this.windowPositions.set([x, y, z], this.windowCount * 3);
    this.windowCount++;
  }

  blocked(terrain, x, z) {
    if (!this.blockers) return false;
    const [gc, gr] = terrain.worldToGrid(x, z);
    return this.blockers[Math.round(gr) * terrain.res + Math.round(gc)] > 0;
  }

  mesh(key, makeGeometry, max) {
    let m = this.meshes.get(key);
    if (!m) {
      const geometry = makeGeometry();
      m = new THREE.InstancedMesh(geometry, geometry.attributes.color ? treeMaterial : buildingMaterial, max);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.userData.max = max;
      this.group.add(m);
      this.meshes.set(key, m);
    }
    return m;
  }

  markDirty() {
    this.dirty = true;
  }

  /** Régénère si nécessaire ; pendant un coup de pinceau, au plus toutes les `throttle` ms. */
  update(terrain, { throttle = 0 } = {}) {
    const now = performance.now();
    if (!this.dirty || now - this.lastRegen < throttle) return;
    this.regenerate(terrain);
    this.dirty = false;
    this.lastRegen = now;
  }

  regenerate(terrain) {
    for (const m of this.meshes.values()) m.count = 0;
    this.windowCount = 0;
    this.stats.trees = this.placeTrees(terrain);
    this.stats.buildings = this.placeBuildings(terrain);
    const pos = this.windows.geometry.attributes.position;
    pos.clearUpdateRanges();
    pos.addUpdateRange(0, this.windowCount * 3);
    pos.needsUpdate = true;
    this.windows.geometry.setDrawRange(0, this.windowCount);
    for (const m of this.meshes.values()) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
  }

  push(m, matrix, color) {
    if (m.count >= m.userData.max) return false;
    m.setMatrixAt(m.count, matrix);
    m.setColorAt(m.count, color);
    m.count++;
    return true;
  }

  placeTrees(terrain) {
    const b = terrain.biome;
    const totalW = b.trees.reduce((s, t) => s + t.w, 0);
    const meshes = b.trees.map((t) => this.mesh('tree-' + t.species, () => mergeGeometries(SPECIES[t.species]()), MAX_TREES));
    const half = terrain.size / 2;
    const n = Math.floor(terrain.size / TREE_SPACING);
    let placed = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -half + (i + 0.15 + 0.7 * hash(i, j, 1)) * TREE_SPACING;
        const z = -half + (j + 0.15 + 0.7 * hash(i, j, 2)) * TREE_SPACING;
        const density = terrain.sample(terrain.forest, x, z) * b.treeDensity;
        if (density <= 0.02 || hash(i, j, 3) > density) continue;
        const h = terrain.heightAt(x, z);
        if (h < 0.5 || h > b.treeLine || terrain.slopeAt(x, z) > 0.45 || this.blocked(terrain, x, z)) continue;

        // Choix de l'essence selon les poids et la plage d'altitude.
        let pick = hash(i, j, 4) * totalW;
        let k = 0;
        for (; k < b.trees.length - 1; k++) {
          pick -= b.trees[k].w;
          if (pick < 0) break;
        }
        const t = b.trees[k];
        if ((t.hMin !== undefined && h < t.hMin) || (t.hMax !== undefined && h > t.hMax)) {
          // Hors plage : on se rabat sur une essence compatible s'il y en a une.
          k = b.trees.findIndex((o) => (o.hMin === undefined || h >= o.hMin) && (o.hMax === undefined || h <= o.hMax));
          if (k < 0) continue;
        }

        // Les arbres rapetissent en approchant de la limite des arbres.
        const scale = (0.75 + 0.55 * hash(i, j, 5)) * (1 - 0.5 * Math.max(0, h / b.treeLine - 0.6));
        _p.set(x, h - 0.03, z);
        _q.setFromAxisAngle(UP, hash(i, j, 6) * Math.PI * 2);
        _s.setScalar(scale);
        _m.compose(_p, _q, _s);
        const v = 0.82 + 0.3 * hash(i, j, 7);
        _c.setRGB(v, v * (0.95 + 0.1 * hash(i, j, 8)), v);
        if (this.push(meshes[k], _m, _c)) placed++;
      }
    }
    return placed;
  }

  placeBuildings(terrain) {
    const b = terrain.biome;
    const style = BUILDING_STYLES[b.town.roof];
    const walls = this.mesh('walls-' + b.town.roof, style.walls, MAX_BUILDINGS);
    const roofs = this.mesh('roof-' + b.town.roof, style.roof, MAX_BUILDINGS);
    // Les immeubles hauts ont un toit plat, quel que soit le style.
    const flat = BUILDING_STYLES.flat;
    const flatRoofs = this.mesh('roof-flat', flat.roof, MAX_BUILDINGS);
    const wallColors = b.town.walls.map((h) => new THREE.Color(h));
    const roofColors = b.town.roofs.map((h) => new THREE.Color(h));
    const half = terrain.size / 2;
    const nb = Math.ceil(terrain.size / TOWN_BLOCK);
    const reach = Math.ceil((TOWN_BLOCK * Math.SQRT1_2) / TOWN_SPACING);
    let placed = 0;

    for (let bj = 0; bj < nb; bj++) {
      for (let bi = 0; bi < nb; bi++) {
        const cx = -half + (bi + 0.5) * TOWN_BLOCK;
        const cz = -half + (bj + 0.5) * TOWN_BLOCK;
        // Zone sans ville dans ce quartier ? On saute (test grossier sur 5 points).
        let any = 0;
        for (const [ox, oz] of [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
          any = Math.max(any, terrain.sample(terrain.town, cx + ox * TOWN_BLOCK, cz + oz * TOWN_BLOCK));
        }
        if (any <= 0) {
          // Le test grossier peut rater une petite tache : on vérifie la grille du quartier.
          let found = false;
          for (let k = 0; k <= 8 && !found; k++) {
            for (let l = 0; l <= 8 && !found; l++) {
              if (terrain.sample(terrain.town, cx + (k / 8 - 0.5) * TOWN_BLOCK, cz + (l / 8 - 0.5) * TOWN_BLOCK) > 0) found = true;
            }
          }
          if (!found) continue;
        }

        const angle = hash(bi, bj, 11) * Math.PI;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Rues : une rangée vide toutes les `streetU` / `streetV` cases.
        const streetU = 4 + Math.floor(hash(bi, bj, 12) * 3);
        const streetV = 3 + Math.floor(hash(bi, bj, 13) * 3);

        for (let v = -reach; v <= reach; v++) {
          if (((v % streetV) + streetV) % streetV === 0) continue;
          for (let u = -reach; u <= reach; u++) {
            if (((u % streetU) + streetU) % streetU === 0) continue;
            const lu = u * TOWN_SPACING;
            const lv = v * TOWN_SPACING;
            const x = cx + lu * cos - lv * sin;
            const z = cz + lu * sin + lv * cos;
            if (Math.abs(x - cx) > TOWN_BLOCK / 2 || Math.abs(z - cz) > TOWN_BLOCK / 2) continue;
            if (!terrain.inside(x, z)) continue;

            const gi = bi * 1000 + u;
            const gj = bj * 1000 + v;
            const density = terrain.sample(terrain.town, x, z);
            if (density <= 0.02 || hash(gi, gj, 14) > density * 1.1) continue;
            const h = terrain.heightAt(x, z);
            if (h < 0.4 || terrain.slopeAt(x, z) > 0.3 || this.blocked(terrain, x, z)) continue;

            // Plus la zone est dense, plus les bâtiments sont grands.
            const w = 0.3 + 0.18 * hash(gi, gj, 15);
            const d = w * (0.7 + 0.5 * hash(gi, gj, 16));
            const tall = Math.max(0, density - 0.7) / 0.3;
            const wallH = (0.2 + 0.15 * hash(gi, gj, 17)) * (1 + tall * (b.town.roof === 'hut' ? 0.3 : 2.5));
            const rot = -angle + (hash(gi, gj, 18) < 0.5 ? 0 : Math.PI / 2);
            _q.setFromAxisAngle(UP, rot);

            _p.set(x, h - 0.05, z);
            _s.set(w, wallH + 0.05, d);
            _m.compose(_p, _q, _s);
            if (!this.push(walls, _m, wallColors[Math.floor(hash(gi, gj, 19) * wallColors.length)])) return placed;

            const isTower = tall > 0.35 && b.town.roof !== 'hut';
            const roofStyle = isTower ? flat : style;
            _p.set(x, h + wallH, z);
            _s.set(w, roofStyle.roofHeight * (isTower ? 1 : Math.min(w, d)), d);
            _m.compose(_p, _q, _s);
            const roofColor = isTower ? _c.copy(wallColors[0]).multiplyScalar(0.8) : roofColors[Math.floor(hash(gi, gj, 20) * roofColors.length)];
            this.push(isTower ? flatRoofs : roofs, _m, roofColor);
            placed++;

            // Fenêtres allumées, sur une façade tirée au hasard (pas toutes les maisons).
            const lit = isTower ? 2 + Math.floor(tall * 3) : hash(gi, gj, 21) < 0.75 ? 1 : 0;
            const cr = Math.cos(rot);
            const sr = Math.sin(rot);
            for (let k = 0; k < lit; k++) {
              const face = Math.floor(hash(gi, gj, 22 + k) * 4);
              const lx = face === 0 ? w / 2 + 0.02 : face === 1 ? -w / 2 - 0.02 : (hash(gi, gj, 30 + k) - 0.5) * w * 0.7;
              const lz = face === 2 ? d / 2 + 0.02 : face === 3 ? -d / 2 - 0.02 : (hash(gi, gj, 30 + k) - 0.5) * d * 0.7;
              const ly = h + wallH * (isTower ? (k + 0.6) / (lit + 0.2) : 0.45);
              this.addWindow(x + lx * cr + lz * sr, ly, z - lx * sr + lz * cr);
            }
          }
        }
      }
    }
    return placed;
  }
}

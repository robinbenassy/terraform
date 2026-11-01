import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { frame, at, TAXI, APRON, gateU, GATE_COUNT } from './airports.js';
import { part, makePath, pointAt } from './util.js';

/**
 * Trafic aérien : dès deux aéroports, des avions enchaînent roulage, décollage, croisière, approche
 * dans l'axe de la piste, atterrissage et retour au stationnement.
 *
 * Météo : un aéroport fermé retient ses départs ; un avion qui arrive sur un aéroport fermé est
 * dérouté vers l'aéroport ouvert le plus proche, ou tourne en circuit d'attente s'il n'y en a pas.
 */

const PLANES_PER_AIRPORT = 2;
const MAX_PLANES = 40;
const TAXI_SPEED = 1;
const LIFTOFF_SPEED = 5.5;
const CRUISE_SPEED = 11;
const APPROACH_SPEED = 6;
const CRUISE_ALT = 26;
const SHORT_ALT = 14;
const APPROACH_DIST = 55; // longueur de la finale (unités)
const APPROACH_ALT = 7;
const HOLD_RADIUS = 14;
const CLEARANCE = 9; // marge au-dessus du relief survolé
const TURNAROUND = [5, 14]; // secondes au stationnement

const rand = (a, b) => a + Math.random() * (b - a);

function planeGeometry() {
  const body = 0xf3f5f7;
  const accent = 0x2f62b5;
  const fuselage = new THREE.CylinderGeometry(0.065, 0.055, 1, 10).rotateZ(Math.PI / 2);
  const nose = new THREE.ConeGeometry(0.065, 0.14, 10).rotateZ(-Math.PI / 2);
  const tail = new THREE.ConeGeometry(0.055, 0.16, 10).rotateZ(Math.PI / 2);
  return mergeGeometries([
    part(fuselage, body, { y: 0.14 }),
    part(nose, body, { x: 0.57, y: 0.14 }),
    part(tail, body, { x: -0.58, y: 0.15 }),
    part(new THREE.BoxGeometry(0.24, 0.018, 1.0), body, { x: 0.02, y: 0.12 }), // ailes
    part(new THREE.BoxGeometry(0.14, 0.012, 0.36), body, { x: -0.55, y: 0.16 }), // empennage horizontal
    part(new THREE.BoxGeometry(0.16, 0.2, 0.016), accent, { x: -0.56, y: 0.26 }), // dérive
    part(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8).rotateZ(Math.PI / 2), 0x9aa3ad, { x: 0.06, y: 0.09, z: 0.22 }),
    part(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8).rotateZ(Math.PI / 2), 0x9aa3ad, { x: 0.06, y: 0.09, z: -0.22 }),
    part(new THREE.BoxGeometry(0.5, 0.012, 0.02), accent, { x: 0.04, y: 0.14, z: 0.066 }), // liseré
    part(new THREE.BoxGeometry(0.5, 0.012, 0.02), accent, { x: 0.04, y: 0.14, z: -0.066 }),
    part(new THREE.BoxGeometry(0.03, 0.08, 0.03), 0x333333, { x: 0.3, y: 0.04 }), // train
    part(new THREE.BoxGeometry(0.03, 0.08, 0.2), 0x333333, { x: -0.02, y: 0.04 }),
  ]);
}

/** Chemin lissé (Catmull-Rom) échantillonné tous les `step`. */
function smoothPath(points, step = 1) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)), false, 'centripetal');
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  return makePath(curve.getSpacedPoints(n));
}

const linePath = (points) => makePath(points.map((p) => ({ x: p.x, y: p.y, z: p.z })));
const P = (f, u, v, y) => ({ ...at(f, u, v), y });

const _a = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
const _b = { x: 0, y: 0, z: 0, dx: 0, dz: 0 };
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _eff = {};

export class Flights {
  constructor(scene, airports, terrain) {
    this.airports = airports;
    this.terrain = terrain;
    this.planes = [];
    this.signature = '';
    this.time = 0;
    this.stats = { planes: 0, flying: 0, delayed: 0, holding: 0, diverted: 0 };
    this.closed = new Map(); // aéroport → perturbation qui le ferme

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    this.mesh = new THREE.InstancedMesh(planeGeometry(), material, MAX_PLANES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Feux à éclats, visibles la nuit.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PLANES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.lights = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 3.5, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.lights.frustumCulled = false;
    this.lights.visible = false;
    scene.add(this.lights);
    this.lightsLevel = 0;
  }

  setLightsLevel(level) {
    this.lightsLevel = level;
  }

  /** À appeler quand la liste des aéroports a pu changer : repart de zéro si elle a changé. */
  sync() {
    const sig = JSON.stringify(this.airports.toJSON().map(({ name, ...geo }) => geo));
    if (sig === this.signature) return;
    this.signature = sig;
    this.planes = [];
    const list = this.airports.list;
    list.forEach((a, i) => {
      for (let k = 0; k < PLANES_PER_AIRPORT && this.planes.length < MAX_PLANES; k++) {
        this.planes.push({ index: this.planes.length, at: a, gate: k, state: 'gate', wait: rand(1, 8) + k * 4 + i, segs: [], seg: 0, s: 0, phase: Math.random() * 10 });
      }
    });
    this.mesh.count = this.planes.length;
    this.lights.geometry.setDrawRange(0, this.planes.length);
    for (const p of this.planes) this.park(p);
  }

  // --- Construction des trajectoires ---

  ground(a) {
    return a.y + 0.05;
  }

  park(plane) {
    const f = frame(plane.at);
    const y = this.ground(plane.at);
    // Nez vers la piste.
    plane.segs = [{ path: linePath([P(f, gateU(f, plane.gate), APRON + 0.01, y), P(f, gateU(f, plane.gate), APRON - 0.01, y)]), speed: () => 0 }];
    plane.seg = 0;
    plane.s = 0;
  }

  freeGate(a) {
    const busy = new Set(this.planes.filter((p) => p.at === a && p.state === 'gate').map((p) => p.gate));
    for (const p of this.planes) if (p.dest === a && p.state === 'in') busy.add(p.gate);
    for (let g = 0; g < GATE_COUNT; g++) if (!busy.has(g)) return g;
    return Math.floor(Math.random() * GATE_COUNT);
  }

  /** Sens d'atterrissage sur `a` en venant de (x, z) : on se pose dans le sens du voyage. */
  landDir(a, x, z) {
    const f = frame(a);
    return (f.cx - x) * f.ux + (f.cz - z) * f.uz >= 0 ? 1 : -1;
  }

  /** Points de la finale de `a` (entrée, puis seuil). */
  finals(a, dir) {
    const f = frame(a);
    const y = this.ground(a);
    const thr = -dir * f.L * 0.42;
    return {
      pre: P(f, thr - dir * (APPROACH_DIST + 22), 0, y + APPROACH_ALT + 3),
      entry: P(f, thr - dir * APPROACH_DIST, 0, y + APPROACH_ALT),
      touchdown: P(f, thr, 0, y),
      f,
      dir,
    };
  }

  /** Vol de (x, y, z) cap (hx, hz) jusqu'à l'entrée de la finale de `dest`, à partir de la vitesse v0. */
  cruise(from, hx, hz, dest, v0 = CRUISE_SPEED) {
    const dir = this.landDir(dest, from.x, from.z);
    const fin = this.finals(dest, dir);
    const dist = Math.hypot(fin.pre.x - from.x, fin.pre.z - from.z);
    let alt = dist > 90 ? CRUISE_ALT : SHORT_ALT;
    // Survol du relief avec une marge (montagnes jusqu'à 60 unités).
    for (let t = 0; t <= 1; t += 4 / Math.max(dist, 4)) {
      const x = from.x + (fin.pre.x - from.x) * t;
      const z = from.z + (fin.pre.z - from.z) * t;
      if (this.terrain.inside(x, z)) alt = Math.max(alt, this.terrain.heightAt(x, z) + CLEARANCE);
    }
    const ahead = { x: from.x + hx * 14, y: Math.max(from.y + 5, Math.min(alt, from.y + 9)), z: from.z + hz * 14 };
    const pts = [from, ahead];
    if (dist > 60) {
      for (const t of [0.35, 0.7]) pts.push({ x: ahead.x + (fin.pre.x - ahead.x) * t, y: alt, z: ahead.z + (fin.pre.z - ahead.z) * t });
    }
    pts.push(fin.pre, fin.entry);
    const path = smoothPath(pts, 1);
    return { path, dir, speed: (s) => Math.min(CRUISE_SPEED, v0 + s * 0.4, APPROACH_SPEED + (path.length - s) * 0.25), kind: 'air' };
  }

  depart(plane, dest) {
    const a = plane.at;
    const f = frame(a);
    const y = this.ground(a);
    const df = frame(dest);
    const dir = (df.cx - f.cx) * f.ux + (df.cz - f.cz) * f.uz >= 0 ? 1 : -1;
    const gu = gateU(f, plane.gate);
    const endU = -dir * f.L * 0.44;
    const taxi = linePath([P(f, gu, APRON, y), P(f, 0, APRON, y), P(f, 0, TAXI, y), P(f, endU, TAXI, y), P(f, endU, 0, y), P(f, -dir * f.L * 0.47, 0, y)]);
    const roll = linePath([P(f, -dir * f.L * 0.47, 0, y), P(f, dir * f.L * 0.12, 0, y)]);
    const liftoff = P(f, dir * f.L * 0.12, 0, y);
    plane.segs = [
      { path: taxi, speed: () => TAXI_SPEED, kind: 'taxi' },
      { path: roll, speed: (s) => Math.min(LIFTOFF_SPEED, 0.8 + s * 0.5), kind: 'roll' },
      this.cruise(liftoff, dir * f.ux, dir * f.uz, dest, LIFTOFF_SPEED),
    ];
    plane.seg = 0;
    plane.s = 0;
    plane.dest = dest;
    plane.state = 'out';
    plane.diverted = false;
  }

  /** Finale, roulage à l'atterrissage et retour au stationnement de `dest`. */
  arrive(plane, dir) {
    const dest = plane.dest;
    const fin = this.finals(dest, dir);
    const { f } = fin;
    const y = this.ground(dest);
    plane.gate = this.freeGate(dest);
    const endU = dir * f.L * 0.44;
    const gu = gateU(f, plane.gate);
    plane.segs = [
      { path: linePath([fin.entry, fin.touchdown]), speed: () => APPROACH_SPEED, kind: 'air' },
      { path: linePath([fin.touchdown, P(f, endU, 0, y)]), speed: (s, len) => Math.max(TAXI_SPEED, APPROACH_SPEED * (1 - s / len)), kind: 'roll' },
      { path: linePath([P(f, endU, 0, y), P(f, endU, TAXI, y), P(f, 0, TAXI, y), P(f, 0, APRON, y), P(f, gu, APRON, y), P(f, gu + dir * 0.01, APRON, y)]), speed: () => TAXI_SPEED, kind: 'taxi' },
    ];
    plane.seg = 0;
    plane.s = 0;
    plane.state = 'in';
  }

  /** Circuit d'attente : un tour complet à droite de la trajectoire actuelle. */
  hold(plane, pos, hx, hz) {
    const cx = pos.x - hz * HOLD_RADIUS;
    const cz = pos.z + hx * HOLD_RADIUS;
    const a0 = Math.atan2(pos.z - cz, pos.x - cx);
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const a = a0 - (k / 24) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * HOLD_RADIUS, y: pos.y, z: cz + Math.sin(a) * HOLD_RADIUS });
    }
    plane.segs = [{ path: smoothPath(pts, 1), speed: () => APPROACH_SPEED + 1, kind: 'air' }];
    plane.seg = 0;
    plane.s = 0;
    plane.state = 'hold';
  }

  /** Fin de croisière (ou d'un tour d'attente) : finale si la destination est ouverte, sinon déroutement ou attente. */
  decide(plane) {
    const seg = plane.segs[plane.seg];
    pointAt(seg.path, seg.path.length, _a);
    pointAt(seg.path, Math.max(0, seg.path.length - 1), _b);
    const pos = { x: _a.x, y: _a.y, z: _a.z };
    const hx = _a.dx;
    const hz = _a.dz;
    if (!this.closed.has(plane.dest)) {
      if (plane.state === 'hold') {
        // Retour vers la finale depuis le circuit d'attente.
        plane.segs = [this.cruise(pos, hx, hz, plane.dest)];
        plane.seg = 0;
        plane.s = 0;
        plane.state = 'out';
        return;
      }
      this.arrive(plane, seg.dir);
      return;
    }
    const open = this.airports.list.filter((a) => a !== plane.dest && !this.closed.has(a));
    if (open.length) {
      open.sort((a, b) => Math.hypot(frame(a).cx - pos.x, frame(a).cz - pos.z) - Math.hypot(frame(b).cx - pos.x, frame(b).cz - pos.z));
      plane.dest = open[0];
      plane.diverted = true;
      plane.segs = [this.cruise(pos, hx, hz, plane.dest)];
      plane.seg = 0;
      plane.s = 0;
      plane.state = 'out';
    } else {
      this.hold(plane, pos, hx, hz);
    }
  }

  // --- Animation ---

  update(dt, weather = null) {
    this.time += dt;
    const list = this.airports.list;
    this.closed.clear();
    if (weather) {
      for (const a of list) {
        const f = frame(a);
        const eff = weather.effectAt(f.cx, f.cz, _eff);
        if (eff.airClosed) this.closed.set(a, eff.airReason);
      }
    }
    const stats = { planes: this.planes.length, flying: 0, delayed: 0, holding: 0, diverted: 0 };

    for (const plane of this.planes) {
      if (plane.state === 'gate') {
        plane.wait -= dt;
        if (plane.wait <= 0 && list.length >= 2) {
          if (this.closed.has(plane.at)) {
            stats.delayed++;
            plane.wait = 0.5;
          } else {
            const others = list.filter((a) => a !== plane.at);
            this.depart(plane, others[Math.floor(Math.random() * others.length)]);
          }
        }
      } else {
        let seg = plane.segs[plane.seg];
        plane.s += Math.max(0.3, seg.speed(plane.s, seg.path.length)) * dt;
        while (plane.s >= seg.path.length) {
          plane.s -= seg.path.length;
          if (plane.seg < plane.segs.length - 1) {
            plane.seg++;
          } else if (plane.state === 'in') {
            plane.at = plane.dest;
            plane.state = 'gate';
            plane.wait = rand(...TURNAROUND);
            this.park(plane);
            break;
          } else {
            this.decide(plane);
          }
          seg = plane.segs[plane.seg];
        }
        if (plane.state === 'hold') stats.holding++;
        if (plane.diverted && plane.state !== 'gate') stats.diverted++;
      }
      this.place(plane, weather);
      const kind = plane.segs[plane.seg]?.kind;
      if (kind === 'air') stats.flying++;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    const blink = this.time % 1.2 < 0.12;
    this.lights.visible = this.lightsLevel > 0.01 && blink && this.planes.length > 0;
    this.lights.material.opacity = this.lightsLevel;
    if (this.lights.visible) this.lights.geometry.attributes.position.needsUpdate = true;
    this.stats = stats;
  }

  /** Position, cap, assiette (pente), inclinaison en virage et turbulences. */
  place(plane, weather) {
    const seg = plane.segs[plane.seg];
    const s = Math.min(plane.s, seg.path.length);
    pointAt(seg.path, s, _a);
    pointAt(seg.path, Math.min(seg.path.length, s + 3), _b);
    const heading = Math.atan2(-_a.dz, _a.dx);
    let pitch = 0;
    let roll = 0;
    if (seg.kind === 'air') {
      const ahead = Math.min(1.5, seg.path.length - s);
      if (ahead > 0.1) {
        pointAt(seg.path, s + ahead, _b);
        pitch = Math.atan2(_b.y - _a.y, ahead);
        pointAt(seg.path, Math.min(seg.path.length, s + 4), _b);
        let turn = Math.atan2(-_b.dz, _b.dx) - heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        roll = Math.max(-0.6, Math.min(0.6, -turn * 1.5));
      }
      if (weather) {
        const eff = weather.effectAt(_a.x, _a.z, _eff);
        const t = this.time + plane.phase;
        roll += eff.rough * 0.18 * Math.sin(t * 9.7);
        pitch += eff.rough * 0.08 * Math.sin(t * 7.3);
        _a.y += eff.rough * 0.25 * Math.sin(t * 5.1);
      }
    }
    _p.set(_a.x, _a.y, _a.z);
    _q.setFromEuler(_e.set(roll, heading, pitch, 'YZX'));
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(plane.index, _m);
    this.lights.geometry.attributes.position.setXYZ(plane.index, _a.x, _a.y + 0.3, _a.z);
  }

  /** État des aéroports pour le panneau : [{ name, reason }] des aéroports fermés. */
  closures() {
    return [...this.closed].map(([a, reason]) => ({ name: a.name, reason }));
  }
}

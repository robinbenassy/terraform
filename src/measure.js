import * as THREE from 'three';
import { METERS_PER_UNIT } from './terrain.js';

const MAX_POINTS = 256;

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 2 : 1 })} km`;
}

export function formatAltitude(h) {
  const m = Math.round(h * METERS_PER_UNIT);
  return m >= 0 ? `${m.toLocaleString('fr-FR')} m` : `−${(-m).toLocaleString('fr-FR')} m (fond)`;
}

/**
 * Outil de mesure : chaque clic ajoute un point, la ligne suit le curseur.
 * Donne la distance à vol d'oiseau (en plan), la distance au sol (relief suivi)
 * et le dénivelé entre le premier point et le curseur.
 */
export class Measure {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.points = [];

    const positions = new Float32Array((MAX_POINTS + 1) * 3);
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
      new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }),
    );
    this.dots = new THREE.Points(
      this.line.geometry,
      new THREE.PointsMaterial({ color: 0xffe066, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    for (const o of [this.line, this.dots]) {
      o.renderOrder = 1000;
      o.frustumCulled = false;
      o.visible = false;
      scene.add(o);
    }
  }

  /** Point de surface : sur l'eau si le sol est immergé. */
  surface(p) {
    return new THREE.Vector3(p.x, Math.max(p.y, 0) + 0.1, p.z);
  }

  add(p) {
    if (this.points.length < MAX_POINTS) this.points.push(this.surface(p));
  }

  removeLast() {
    this.points.pop();
  }

  clear() {
    this.points.length = 0;
  }

  /** Distance au sol le long d'un segment (échantillonnage à la maille). */
  groundLength(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / this.terrain.cell));
    let len = 0;
    let px = a.x;
    let pz = a.z;
    let py = Math.max(this.terrain.heightAt(px, pz), 0);
    for (let k = 1; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      const y = Math.max(this.terrain.heightAt(x, z), 0);
      len += Math.hypot(x - px, y - py, z - pz);
      px = x;
      py = y;
      pz = z;
    }
    return len;
  }

  /** Met à jour la ligne (avec le curseur en dernier point) et renvoie le texte du résumé, ou null. */
  update(cursor) {
    const pts = cursor ? [...this.points, this.surface(cursor)] : this.points;
    const pos = this.line.geometry.attributes.position;
    pts.forEach((p, k) => pos.setXYZ(k, p.x, p.y, p.z));
    pos.needsUpdate = true;
    this.line.geometry.setDrawRange(0, pts.length);
    this.line.visible = this.dots.visible = pts.length > 0;
    if (pts.length < 2) return null;

    let flat = 0;
    let ground = 0;
    for (let k = 1; k < pts.length; k++) {
      flat += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
      ground += this.groundLength(pts[k - 1], pts[k]);
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dh = (last.y - first.y) * METERS_PER_UNIT;
    const lines = [`<b>${formatDistance(flat * METERS_PER_UNIT)}</b>`];
    if (ground > flat * 1.005) lines.push(`au sol : ${formatDistance(ground * METERS_PER_UNIT)}`);
    if (Math.abs(dh) >= 1) lines.push(`dénivelé : ${dh > 0 ? '+' : '−'}${Math.round(Math.abs(dh)).toLocaleString('fr-FR')} m`);
    return lines.join('<br>');
  }
}

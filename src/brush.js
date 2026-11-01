import { MIN_HEIGHT, MAX_HEIGHT, ZONES } from './terrain.js';

/** Outils de relief et de zones. `erase` (Maj) inverse : abaisse au lieu d'élever, gomme une zone. */
export const BRUSH_TOOLS = ['raise', 'lower', 'smooth', 'flatten', ...ZONES];

/** Couches modifiées par chaque outil (pour l'historique). */
export const TOOL_LAYERS = {
  raise: ['heights'],
  lower: ['heights'],
  smooth: ['heights'],
  flatten: ['heights'],
  forest: ZONES,
  town: ZONES,
  fields: ZONES,
};

// Vitesse d'élévation (unités/seconde) à force 1.
const RAISE_RATE = 20;
// Vitesse de remplissage d'une zone (0..1 par seconde) à force 1.
const ZONE_RATE = 6;

/**
 * Applique le pinceau pendant `dt` secondes autour du point monde (x, z).
 * Atténuation en cosinus : pleine force au centre, nulle au bord.
 */
export function applyBrush(terrain, { tool, erase, x, z, radius, strength, dt, target }) {
  const { res, cell, heights } = terrain;
  if (tool === 'raise' && erase) tool = 'lower';
  else if (tool === 'lower' && erase) tool = 'raise';

  const [gc, gr] = terrain.worldToGrid(x, z);
  const rg = radius / cell;
  const c0 = Math.max(0, Math.floor(gc - rg));
  const c1 = Math.min(res - 1, Math.ceil(gc + rg));
  const r0 = Math.max(0, Math.floor(gr - rg));
  const r1 = Math.min(res - 1, Math.ceil(gr + rg));
  if (c0 > c1 || r0 > r1) return;

  // Le lissage lit une copie pour ne pas dépendre de l'ordre de parcours.
  const src = tool === 'smooth' ? heights.slice() : heights;
  const blend = Math.min(1, strength * (tool === 'smooth' ? 12 : 8) * dt);
  const zone = ZONE_RATE * strength * dt;
  // Une zone peinte chasse les autres (pas de forêt dans une ville).
  const isZone = ZONES.includes(tool);
  const paint = isZone ? terrain[tool] : null;
  const others = isZone ? ZONES.filter((z) => z !== tool).map((z) => terrain[z]) : [];

  for (let r = r0; r <= r1; r++) {
    const dz = (r - gr) * cell;
    for (let c = c0; c <= c1; c++) {
      const dx = (c - gc) * cell;
      const d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      const f = 0.5 * (1 + Math.cos((Math.PI * d) / radius));
      const i = r * res + c;

      if (isZone) {
        if (erase) {
          paint[i] = Math.max(0, paint[i] - zone * f);
        } else {
          paint[i] = Math.min(1, paint[i] + zone * f);
          for (const other of others) other[i] = Math.max(0, other[i] - zone * f);
        }
        continue;
      }

      let h = heights[i];
      switch (tool) {
        case 'raise':
          h += RAISE_RATE * strength * dt * f;
          break;
        case 'lower':
          h -= RAISE_RATE * strength * dt * f;
          break;
        case 'smooth': {
          let sum = 0;
          let n = 0;
          for (let rr = Math.max(r - 1, 0); rr <= Math.min(r + 1, res - 1); rr++) {
            for (let cc = Math.max(c - 1, 0); cc <= Math.min(c + 1, res - 1); cc++) {
              sum += src[rr * res + cc];
              n++;
            }
          }
          h += (sum / n - h) * blend * f;
          break;
        }
        case 'flatten':
          h += (target - h) * blend * f;
          break;
      }
      heights[i] = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h));
    }
  }

  terrain.refresh(c0, r0, c1, r1);
}

/**
 * Sauvegarde des îles.
 *
 * Format fichier (.island.json), version 3 :
 * {
 *   format: "islands-terraformer", version: 3,
 *   name, biome, createdAt, updatedAt,
 *   size, resolution,          // monde size x size unités (1 unité = 50 m), grille resolution x resolution
 *   heightScale: 0.01,         // hauteur = int16 * heightScale
 *   encoding: "int16le+gzip+base64",
 *   data: "<base64>",
 *   layers: { forest, town, fields: "<base64>" },   // uint8 (0..255) + gzip + base64
 *   roads: [[[x, z], ...], ...],                       // points de contrôle des routes (unités monde)
 *   ports: [{ x, z, dx, dz }],                         // côte et point d'accostage
 *   towns: [{ x, z, name }],                           // noms des villes (ancre dans la ville)
 *   airports: [{ x1, z1, x2, z2, side, y, name }]      // piste, côté de l'aérogare, altitude aplanie
 * }
 * Les versions précédentes restent lisibles (couches absentes = vides) ; la v1 (zone de 200) est
 * recentrée dans la zone actuelle.
 *
 * Emplacement des sauvegardes (voir init) : fichiers du projet (dossier `saves/`, via l'API du serveur
 * Vite, saves-plugin.js) ou, sur un site statique, base IndexedDB du navigateur. Les sauvegardes
 * portent en plus une miniature (`thumb`). L'ancien stockage localStorage n'est plus que lu, pour
 * migrer son contenu.
 */

import { SEA_FLOOR, ZONES } from './terrain.js';
import { DEFAULT_BIOME } from './biomes.js';

const FORMAT = 'islands-terraformer';
const VERSION = 3;
const SCALE = 100;
const INDEX_KEY = 'islands.index';
const SAVE_PREFIX = 'islands.save.';
const AUTOSAVE_KEY = 'islands.autosave';

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const pack = async (bytes) => toBase64(await pipe(bytes, new CompressionStream('gzip')));
const unpack = (b64) => pipe(fromBase64(b64), new DecompressionStream('gzip'));

/**
 * Rééchantillonnage bilinéaire d'une couche carrée vers une autre grille, en coordonnées monde
 * (les deux zones sont centrées sur l'origine). Hors de la zone source : `fill`.
 */
function remap(src, srcSize, srcRes, dstSize, dstRes, fill) {
  if (srcSize === dstSize && srcRes === dstRes) return src;
  const out = new Float32Array(dstRes * dstRes);
  const srcCell = srcSize / (srcRes - 1);
  const dstCell = dstSize / (dstRes - 1);
  for (let r = 0; r < dstRes; r++) {
    const y = (-dstSize / 2 + r * dstCell + srcSize / 2) / srcCell;
    for (let c = 0; c < dstRes; c++) {
      const x = (-dstSize / 2 + c * dstCell + srcSize / 2) / srcCell;
      if (x < 0 || y < 0 || x > srcRes - 1 || y > srcRes - 1) {
        out[r * dstRes + c] = fill;
        continue;
      }
      const c0 = Math.min(Math.floor(x), srcRes - 2);
      const r0 = Math.min(Math.floor(y), srcRes - 2);
      const fx = x - c0;
      const fy = y - r0;
      const i = r0 * srcRes + c0;
      const top = src[i] * (1 - fx) + src[i + 1] * fx;
      const bottom = src[i + srcRes] * (1 - fx) + src[i + srcRes + 1] * fx;
      out[r * dstRes + c] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

export async function serialize(terrain, { name, createdAt, roads = [], ports = [], towns = [], airports = [] }) {
  const q = new Int16Array(terrain.heights.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(terrain.heights[i] * SCALE)));
  const layers = {};
  for (const key of ZONES) layers[key] = await pack(Uint8Array.from(terrain[key], (v) => Math.round(v * 255)));
  const now = new Date().toISOString();
  return {
    format: FORMAT,
    version: VERSION,
    name,
    biome: terrain.biome.id,
    createdAt: createdAt ?? now,
    updatedAt: now,
    size: terrain.size,
    resolution: terrain.res,
    heightScale: 1 / SCALE,
    encoding: 'int16le+gzip+base64',
    data: await pack(new Uint8Array(q.buffer)),
    layers,
    roads,
    ports,
    towns,
    airports,
  };
}

/** Décode un objet sauvegardé en couches adaptées au terrain cible. */
export async function deserialize(obj, terrain) {
  if (!obj || obj.format !== FORMAT) throw new Error("Ce fichier n'est pas une île du terraformeur.");
  if (obj.version > VERSION) throw new Error(`Version de fichier non supportée (${obj.version}).`);
  const n = obj.resolution * obj.resolution;
  const bytes = await unpack(obj.data);
  const q = new Int16Array(bytes.buffer, 0, bytes.byteLength / 2);
  if (q.length !== n) throw new Error('Données de hauteur corrompues.');
  const size = obj.size ?? 200;
  const fit = (arr, fill) => remap(arr, size, obj.resolution, terrain.size, terrain.res, fill);

  const result = {
    name: obj.name,
    createdAt: obj.createdAt,
    biome: obj.biome ?? DEFAULT_BIOME,
    heights: fit(Float32Array.from(q, (v) => v * obj.heightScale), SEA_FLOOR),
    roads: obj.roads ?? [],
    ports: obj.ports ?? [],
    towns: obj.towns ?? [],
    airports: obj.airports ?? [],
  };
  for (const key of ZONES) {
    if (!obj.layers?.[key]) {
      result[key] = new Float32Array(terrain.res * terrain.res);
      continue;
    }
    const raw = await unpack(obj.layers[key]);
    if (raw.length !== n) throw new Error(`Couche « ${key} » corrompue.`);
    result[key] = fit(Float32Array.from(raw, (v) => v / 255), 0);
  }
  return result;
}

// --- Deux emplacements possibles : fichiers du projet (serveur de dev) ou navigateur (IndexedDB) ---

const slug = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'ile';

/** Fichiers du projet, via l'API du serveur Vite (saves-plugin.js). */
const serverBackend = {
  kind: 'server',
  async call(method, url, data) {
    const res = await fetch(url, {
      method,
      headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `erreur serveur ${res.status}`);
    return res.json();
  },
  list() {
    return this.call('GET', '/api/saves');
  },
  async write(id, body) {
    return (id ? await this.call('PUT', `/api/saves/${encodeURIComponent(id)}`, body) : await this.call('POST', '/api/saves', body)).id;
  },
  read(id) {
    return this.call('GET', `/api/saves/${encodeURIComponent(id)}`).catch(() => null);
  },
  remove(id) {
    return this.call('DELETE', `/api/saves/${encodeURIComponent(id)}`);
  },
  writeAutosave(state) {
    return this.call('PUT', '/api/autosave', state);
  },
  readAutosave() {
    return this.call('GET', '/api/autosave').catch(() => null);
  },
};

/**
 * Navigateur : base IndexedDB « islands » (îles complètes, index des vignettes, autosauvegarde).
 * Mêmes identifiants que les fichiers : dérivés du nom de l'île, suffixés en cas de doublon.
 */
const browserBackend = {
  kind: 'browser',
  db: null,
  open() {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('islands', 1);
      req.onupgradeneeded = () => {
        for (const name of ['saves', 'index', 'meta']) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  /** Transaction sur `stores` ; `fn(stores)` renvoie éventuellement une requête dont on rend le résultat. */
  async tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = fn(...stores.map((n) => t.objectStore(n)));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('stockage du navigateur indisponible'));
    });
  },
  async list() {
    const all = await this.tx(['index'], 'readonly', (index) => index.getAll());
    return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async write(id, body) {
    const taken = new Set((await this.list()).map((e) => e.id));
    const base = slug(body.name);
    let target = base;
    for (let n = 2; target !== id && taken.has(target); n++) target = `${base}-${n}`;
    const { thumb, ...data } = body;
    await this.tx(['saves', 'index'], 'readwrite', (saves, index) => {
      if (id && id !== target) {
        saves.delete(id);
        index.delete(id);
      }
      saves.put(data, target);
      index.put({ id: target, name: data.name, updatedAt: data.updatedAt, thumb: thumb ?? null }, target);
    });
    return target;
  },
  async read(id) {
    return (await this.tx(['saves'], 'readonly', (saves) => saves.get(id))) ?? null;
  },
  remove(id) {
    return this.tx(['saves', 'index'], 'readwrite', (saves, index) => {
      saves.delete(id);
      index.delete(id);
    });
  },
  writeAutosave(state) {
    return this.tx(['meta'], 'readwrite', (meta) => meta.put(state, 'autosave'));
  },
  async readAutosave() {
    return (await this.tx(['meta'], 'readonly', (meta) => meta.get('autosave')).catch(() => null)) ?? null;
  },
};

let ready = null;

/**
 * Choisit (une fois) l'emplacement des sauvegardes : les fichiers du projet si l'API du serveur
 * répond (npm run dev / preview), sinon le navigateur (site statique, ex. GitHub Pages).
 * Renvoie { kind: 'server' | 'browser', persisted, backend }.
 */
export function init() {
  ready ??= (async () => {
    try {
      const res = await fetch('/api/saves', { signal: AbortSignal.timeout(3000) });
      if (res.ok && res.headers.get('content-type')?.includes('json')) return { kind: 'server', backend: serverBackend };
    } catch {
      // Pas de serveur : stockage navigateur.
    }
    await browserBackend.open();
    // Demande au navigateur de ne pas effacer ces données quand l'espace manque.
    const persisted = (await navigator.storage?.persist?.().catch(() => false)) ?? false;
    return { kind: 'browser', persisted, backend: browserBackend };
  })();
  return ready;
}

const backend = async () => (await init()).backend;

export const listSaves = async () => (await backend()).list();

/** Écrit une sauvegarde ; renvoie son id (il suit le nom de l'île, il peut donc changer). */
export const writeSave = async ({ id, data, thumb }) => (await backend()).write(id, { ...data, thumb });
export const readSave = async (id) => (await backend()).read(id);
export const deleteSave = async (id) => (await backend()).remove(id);
export const writeAutosave = async (state) => (await backend()).writeAutosave(state);
export const readAutosave = async () => (await backend()).readAutosave();

// --- Export / import de toutes les îles en un seul fichier ---

const BUNDLE = 'islands-terraformer-bundle';

export async function exportAll() {
  const islands = [];
  for (const { id, thumb } of await listSaves()) {
    const data = await readSave(id);
    if (data) islands.push({ ...data, thumb: data.thumb ?? thumb ?? null });
  }
  return { format: BUNDLE, version: 1, exportedAt: new Date().toISOString(), islands };
}

export const isBundle = (obj) => obj?.format === BUNDLE && Array.isArray(obj.islands);

/** Ajoute aux sauvegardes les îles d'un fichier « tout exporter » ; renvoie le nombre d'îles ajoutées. */
export async function importBundle(obj) {
  let n = 0;
  for (const island of obj.islands) {
    if (island?.format !== FORMAT) continue;
    const { thumb, ...data } = island;
    await writeSave({ data, thumb: thumb ?? null });
    n++;
  }
  return n;
}

// --- Ancien stockage (localStorage) : migration vers l'emplacement courant ---

const LEGACY_MIGRATED = 'islands.migrated';

/**
 * Copie les îles encore dans localStorage et pas encore migrées vers l'emplacement courant
 * (localStorage est laissé intact). Renvoie { count, ids } où ids associe ancien id → nouvel id.
 */
export async function migrateLegacy() {
  let index;
  let done;
  try {
    index = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    done = JSON.parse(localStorage.getItem(LEGACY_MIGRATED) || '{}');
  } catch {
    return { count: 0, ids: {} };
  }
  let count = 0;
  for (const entry of index) {
    if (done[entry.id]) continue;
    const raw = localStorage.getItem(SAVE_PREFIX + entry.id);
    if (!raw) continue;
    done[entry.id] = await writeSave({ data: JSON.parse(raw), thumb: entry.thumb });
    count++;
    localStorage.setItem(LEGACY_MIGRATED, JSON.stringify(done));
  }
  return { count, ids: done };
}

/** Dernière session de l'ancien stockage (pour la reprendre s'il n'y a pas encore d'autosauvegarde). */
export function readLegacyAutosave() {
  try {
    return JSON.parse(localStorage.getItem(AUTOSAVE_KEY));
  } catch {
    return null;
  }
}

export function downloadJSON(obj, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Terrain, SEA_FLOOR, METERS_PER_UNIT, ZONES } from './terrain.js';
import { BIOMES, DEFAULT_BIOME } from './biomes.js';
import { applyBrush, BRUSH_TOOLS, TOOL_LAYERS } from './brush.js';
import { Props } from './props.js';
import { Measure, formatDistance, formatAltitude } from './measure.js';
import { Roads } from './roads.js';
import { Ports } from './ports.js';
import { Traffic } from './traffic.js';
import { Towns } from './towns.js';
import { Weather } from './weather.js';
import { Airports, RUNWAY_MIN, RUNWAY_MAX } from './airports.js';
import { Flights } from './flights.js';
import * as storage from './storage.js';

// Raccourcis clavier : 1–9 puis 0 pour le dixième outil.
const TOOLS = [...BRUSH_TOOLS, 'road', 'port', 'measure', 'airport'];
const LETTER_KEYS = { airport: 'a' };
const toolKey = (i) => LETTER_KEYS[TOOLS[i]] ?? String((i + 1) % 10);

// Interface tactile / petit écran : barre d'outils mobile, gestes à un ou deux doigts, rendu allégé.
const touchUI = matchMedia('(max-width: 820px), (pointer: coarse)').matches;

// --- Scène ---

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, touchUI ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color();
scene.fog = new THREE.Fog(0xffffff, 700, 2800);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.5, 8000);
camera.position.set(0, 170, 230);

const controls = new OrbitControls(camera, canvas);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.enableDamping = true;
controls.zoomSpeed = 2;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 4;
controls.maxDistance = 1300;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const hemi = new THREE.HemisphereLight(0xdff3ff, 0x3a5a40, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.position.set(240, 360, 160);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(touchUI ? 2048 : 4096);
Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 10, far: 1200 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.3;
scene.add(sun);

const terrain = new Terrain({ size: 400, resolution: 513 });
scene.add(terrain.mesh);
const props = new Props(scene);
const measure = new Measure(scene, terrain);
const roads = new Roads(scene, terrain);
const ports = new Ports(scene, terrain);
const towns = new Towns(terrain);
const traffic = new Traffic(scene, terrain, roads, ports, towns);
const weather = new Weather({ scene, sun, hemi });
const airports = new Airports(scene, terrain);
const flights = new Flights(scene, airports, terrain);

// Fond marin autour de la zone éditable (carré troué), pour que l'océan paraisse infini.
const seabed = (() => {
  const outer = new THREE.Shape().moveTo(-4000, -4000).lineTo(4000, -4000).lineTo(4000, 4000).lineTo(-4000, 4000);
  const h = terrain.size / 2;
  outer.holes.push(new THREE.Path().moveTo(-h, -h).lineTo(-h, h).lineTo(h, h).lineTo(h, -h));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(outer).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 1 }));
  mesh.position.y = SEA_FLOOR;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
})();

const water = new THREE.Mesh(
  new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.15 }),
);
scene.add(water);

// Limite de la zone éditable, discrète, à la surface de l'eau.
{
  const h = terrain.size / 2;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(x, 0.05, z))),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }),
  );
  scene.add(border);
}

function applyBiome(id) {
  terrain.setBiome(id);
  const b = terrain.biome;
  scene.background.setHex(b.sky);
  scene.fog.color.setHex(b.sky);
  water.material.color.setHex(b.water);
  water.material.opacity = b.waterOpacity;
  seabed.material.color.setHex(b.deep);
  roads.setColor(b.road);
  weather.setBiome(b);
  ui.stormType.replaceChildren(...weather.types().map((t) => new Option(t.label, t.id)));
  ui.biome.value = b.id;
  props.markDirty();
}

// Curseur du pinceau : cercle qui épouse le relief.
const CURSOR_SEGMENTS = 96;
const cursor = new THREE.LineLoop(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(CURSOR_SEGMENTS * 3), 3)),
  new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }),
);
cursor.renderOrder = 999;
cursor.frustumCulled = false;
cursor.visible = false;
scene.add(cursor);

const TOOL_COLORS = { raise: 0xffffff, lower: 0xff8a65, smooth: 0x9be7ff, flatten: 0xfff27a, forest: 0x7dff8a, town: 0xd0a0ff, fields: 0xf2d16b };
const ERASE_COLOR = 0xff5555;

function updateCursor(point, radius, color) {
  const pos = cursor.geometry.attributes.position.array;
  for (let k = 0; k < CURSOR_SEGMENTS; k++) {
    const a = (k / CURSOR_SEGMENTS) * Math.PI * 2;
    const x = point.x + Math.cos(a) * radius;
    const z = point.z + Math.sin(a) * radius;
    pos[k * 3] = x;
    pos[k * 3 + 1] = Math.max(terrain.heightAt(x, z), 0) + 0.15;
    pos[k * 3 + 2] = z;
  }
  cursor.geometry.attributes.position.needsUpdate = true;
  cursor.material.color.setHex(color);
}

// --- État de l'éditeur ---

const state = {
  tool: 'raise',
  radius: 20,
  strength: 0.4,
  shift: false,
  painting: false,
  flattenTarget: 0,
  currentId: null,
  createdAt: null,
  airportStart: null, // point d'appui pendant le tracé d'une piste
  eraseMode: false, // bouton « Gomme » (mobile) : équivaut à Maj enfoncée
  viewMode: false, // bouton « Vue » (mobile) : un doigt fait tourner la vue au lieu d'utiliser l'outil
};

/** Maj enfoncée ou mode gomme : inverser, gommer ou supprimer selon l'outil. */
const erasing = () => state.shift || state.eraseMode;

const isZoneTool = (t) => ZONES.includes(t);

// Vue carte (voir plus bas) : caméra à la verticale, outils inactifs.
const mapView = { active: false, saved: null, anim: null };

// Historique : instantanés des couches touchées (513² floats ≈ 1 Mo par couche) et des réseaux.
const HISTORY_LIMIT = 30;
const undoStack = [];
const redoStack = [];
const ALL_LAYERS = ['heights', ...ZONES, 'roads', 'ports', 'towns', 'airports'];
const NETWORKS = { roads, ports, towns, airports };

const snapshot = (keys) => Object.fromEntries(keys.map((k) => [k, NETWORKS[k] ? NETWORKS[k].snapshot() : terrain[k].slice()]));

function pushHistory(keys = ALL_LAYERS) {
  commitHistory(snapshot(keys));
}

function commitHistory(entry) {
  undoStack.push(entry);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function stepHistory(from, to) {
  if (!from.length) return;
  const entry = from.pop();
  to.push(snapshot(Object.keys(entry)));
  applyEntry(entry);
}

/** Annule le coup de pinceau en cours (déjà inscrit dans l'historique) sans laisser de trace. */
function abortStroke() {
  state.painting = false;
  const entry = undoStack.pop();
  if (entry) applyEntry(entry);
}

function applyEntry(entry) {
  const layers = {};
  for (const [k, v] of Object.entries(entry)) {
    if (NETWORKS[k]) NETWORKS[k].restore(v);
    else layers[k] = v;
  }
  terrain.setLayers(layers);
  towns.update();
  afterTerrainChange();
  updateHistoryButtons();
}

// Routes et ports écartent arbres et bâtiments.
const blockers = new Uint8Array(terrain.res * terrain.res);
props.blockers = blockers;

/** Redrape routes et ports sur le relief et met à jour les emprises. */
function rebuildNetworks() {
  roads.rebuild();
  ports.rebuild();
  blockers.fill(0);
  roads.rasterize(blockers);
  ports.rasterize(blockers);
  airports.rasterize(blockers);
  props.markDirty();
}

// Recalcul des villes et des itinéraires (îles, trajets maritimes) : différé, c'est le plus coûteux.
let trafficTimer;
function scheduleTraffic() {
  clearTimeout(trafficTimer);
  trafficTimer = setTimeout(() => {
    towns.update();
    traffic.rebuild();
    flights.sync();
  }, 300);
}

function afterTerrainChange() {
  rebuildNetworks();
  props.markDirty();
  scheduleTraffic();
  updateStats();
  scheduleAutosave();
}

// --- Saisie ---

const ndc = new THREE.Vector2();
const screen = { x: 0, y: 0 };
const raycaster = new THREE.Raycaster();
const hit = new THREE.Vector3();
let pointerInside = false;
let hasHit = false;

function setPointer(e) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  screen.x = e.clientX;
  screen.y = e.clientY;
  state.shift = e.shiftKey;
}

function pick() {
  raycaster.setFromCamera(ndc, camera);
  hasHit = pointerInside && terrain.raycast(raycaster.ray, hit) !== null;
}

canvas.addEventListener('pointermove', (e) => {
  pointerInside = true;
  setPointer(e);
});
canvas.addEventListener('pointerleave', () => {
  if (!state.painting) pointerInside = false;
});
// Outils à un clic : sur écran tactile, l'action attend que le doigt se lève sans avoir bougé,
// pour ne pas poser de point au début d'un geste à deux doigts.
const TAP_TOOLS = ['measure', 'road', 'port'];
const touches = new Set();
let tap = null; // { id, x, y }

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touches.add(e.pointerId);
    // Deuxième doigt : c'est un geste de caméra, on abandonne l'action du premier.
    if (touches.size > 1) {
      cancelGesture();
      return;
    }
  }
  if (document.body.classList.contains('drawer-open')) {
    setDrawer(false);
    return;
  }
  if (e.button !== 0 || mapView.active || state.viewMode) return;
  pointerInside = true;
  setPointer(e);
  pick();
  if (!hasHit) return;
  if (TAP_TOOLS.includes(state.tool)) {
    if (e.pointerType === 'touch') tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
    else toolTap();
    return;
  }
  if (state.tool === 'airport') {
    if (erasing()) {
      const i = airports.pick(hit.x, hit.z);
      if (i < 0) return;
      const { name } = airports.list[i];
      pushHistory(['airports']);
      airports.remove(i);
      afterTerrainChange();
      toast(`${name} supprimé`);
    } else {
      canvas.setPointerCapture(e.pointerId);
      state.airportStart = { x: hit.x, z: hit.z };
    }
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  pushHistory([...TOOL_LAYERS[state.tool], 'towns']);
  state.painting = true;
  state.flattenTarget = hit.y;
});

/** Action d'un outil à un clic (mesure, route, port) au point visé. */
function toolTap() {
  if (state.tool === 'measure') {
    measure.add(hit);
    return;
  }
  if (state.tool === 'road') {
    if (erasing()) {
      const i = roads.pickEdge(hit.x, hit.z);
      if (i >= 0) {
        pushHistory(['roads']);
        roads.removeEdge(i);
        afterTerrainChange();
        toast('Tronçon supprimé');
      }
    } else {
      roads.addDraftPoint(hit);
    }
    return;
  }
  if (state.tool === 'port') {
    const before = snapshot(['ports']);
    if (erasing()) {
      const i = ports.pick(hit.x, hit.z);
      if (i < 0) return;
      ports.remove(i);
      toast('Port supprimé');
    } else if (!ports.place(hit)) {
      toast('Pas de côte avec de l\'eau profonde à proximité', true);
      return;
    }
    commitHistory(before);
    afterTerrainChange();
  }
}

function cancelGesture() {
  tap = null;
  state.airportStart = null;
  airports.updatePreview(null);
  if (state.painting) abortStroke();
}

const endStroke = (e) => {
  if (e.pointerType === 'touch') touches.delete(e.pointerId);
  if (tap && e.pointerId === tap.id) {
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    tap = null;
    if (moved > 12 || e.type === 'pointercancel') return;
    setPointer(e);
    pick();
    if (hasHit) toolTap();
    return;
  }
  if (e.button === 0 && state.airportStart) {
    if (e.type !== 'pointercancel') buildAirport(state.airportStart);
    state.airportStart = null;
    return;
  }
  if (e.button !== 0 || !state.painting) return;
  state.painting = false;
  afterTerrainChange();
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('dblclick', () => {
  if (state.tool === 'road') finishRoad();
});

/**
 * Piste proposée : glissée depuis le point d'appui, sinon orientée automatiquement autour du
 * curseur. L'aérogare va du côté le plus favorable.
 */
function airportCandidate(start = state.airportStart) {
  if (!hasHit) return null;
  if (!start || Math.hypot(hit.x - start.x, hit.z - start.z) < 4) return airports.autoRunway(start?.x ?? hit.x, start?.z ?? hit.z);
  let dx = hit.x - start.x;
  let dz = hit.z - start.z;
  const len = Math.hypot(dx, dz);
  const L = Math.min(RUNWAY_MAX, Math.max(RUNWAY_MIN, len));
  dx = (dx / len) * L;
  dz = (dz / len) * L;
  const base = { x1: start.x, z1: start.z, x2: start.x + dx, z2: start.z + dz };
  const [a, b] = [1, -1].map((side) => ({ ...base, side }));
  return airports.survey(a).spread <= airports.survey(b).spread ? a : b;
}

/** Nom par défaut : d'après la ville la plus proche (« Aéroport de … »). */
function airportName(c) {
  const x = (c.x1 + c.x2) / 2;
  const z = (c.z1 + c.z2) / 2;
  const town = towns.list.filter((t) => Math.hypot(t.x - x, t.z - z) < 100).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  const taken = new Set(airports.list.map((a) => a.name));
  if (town) {
    const n = town.entry.name;
    const name = /^Le /.test(n) ? `Aéroport du ${n.slice(3)}` : /^Les /.test(n) ? `Aéroport des ${n.slice(4)}` : /^[AEIOUYÉÈÊÀÂÎÔÛ]/i.test(n) ? `Aéroport d'${n}` : `Aéroport de ${n}`;
    if (!taken.has(name)) return name;
  }
  for (let k = 1; ; k++) if (!taken.has(`Aéroport ${k}`)) return `Aéroport ${k}`;
}

function buildAirport(start) {
  const c = airportCandidate(start);
  airports.updatePreview(null);
  if (!c) return;
  const error = airports.check(c);
  if (error) {
    toast(error, true);
    return;
  }
  pushHistory(['heights', ...ZONES, 'airports', 'towns']);
  const a = airports.place(c, airportName(c));
  towns.update();
  afterTerrainChange();
  toast(`${a.name} construit`);
}

function finishRoad() {
  const before = snapshot(['roads']);
  if (roads.commitDraft()) {
    commitHistory(before);
    afterTerrainChange();
  }
}
canvas.addEventListener('pointercancel', endStroke);

window.addEventListener('keydown', (e) => {
  state.shift = e.shiftKey;
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    e.shiftKey ? stepHistory(redoStack, undoStack) : stepHistory(undoStack, redoStack);
  } else if (mod && key === 'y') {
    e.preventDefault();
    stepHistory(redoStack, undoStack);
  } else if (mod && key === 's') {
    e.preventDefault();
    save();
  } else if (!mod && key === 't') {
    toggleClock();
  } else if (!mod && key === 'm') {
    setMapView(!mapView.active);
  } else if (mapView.active && e.key === 'Escape') {
    setMapView(false);
  } else if (!mod && TOOLS.some((_, i) => toolKey(i) === key)) {
    setTool(TOOLS[TOOLS.findIndex((_, i) => toolKey(i) === key)]);
  } else if (e.key === '[') {
    setRadius(state.radius / 1.15);
  } else if (e.key === ']') {
    setRadius(state.radius * 1.15);
  } else if (state.tool === 'road' && e.key === 'Enter') {
    finishRoad();
  } else if (state.tool === 'road' && e.key === 'Escape') {
    roads.cancelDraft();
  } else if (state.tool === 'road' && e.key === 'Backspace') {
    e.preventDefault();
    roads.removeLastDraft();
  } else if (state.tool === 'measure' && e.key === 'Escape') {
    measure.clear();
  } else if (state.tool === 'measure' && e.key === 'Backspace') {
    e.preventDefault();
    measure.removeLast();
  }
});
window.addEventListener('keyup', (e) => {
  state.shift = e.shiftKey;
});
window.addEventListener('blur', () => {
  state.shift = false;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Interface ---

const $ = (id) => document.getElementById(id);
const ui = {
  tools: $('tools'),
  radius: $('radius'),
  radiusOut: $('radiusOut'),
  strength: $('strength'),
  strengthOut: $('strengthOut'),
  undo: $('undo'),
  redo: $('redo'),
  name: $('name'),
  biome: $('biome'),
  saves: $('saves'),
  importFile: $('importFile'),
  toast: $('toast'),
  hud: $('hud'),
  measureLabel: $('measureLabel'),
  scalebar: $('scalebar'),
  mapView: $('mapView'),
  mRadius: $('mRadius'),
  mRadiusOut: $('mRadiusOut'),
  mStrength: $('mStrength'),
  mStrengthOut: $('mStrengthOut'),
  mobileBar: $('mobileBar'),
  ctxBar: $('ctxBar'),
  toolBar: $('toolBar'),
  clock: $('clock'),
  clockOut: $('clockOut'),
  clockPlay: $('clockPlay'),
  dayLength: $('dayLength'),
  weatherMode: $('weatherMode'),
  stormType: $('stormType'),
  stormGo: $('stormGo'),
  weatherStatus: $('weatherStatus'),
  townLabels: $('townLabels'),
};

for (const b of Object.values(BIOMES)) ui.biome.append(new Option(b.label, b.id));

function setTool(tool) {
  setMapView(false);
  if (state.viewMode) setViewMode(false);
  if (state.tool === 'measure' && tool !== 'measure') {
    measure.clear();
    measure.update(null);
  }
  if (state.tool === 'road' && tool !== 'road') roads.cancelDraft();
  if (tool !== 'airport') {
    state.airportStart = null;
    airports.updatePreview(null);
  }
  state.tool = tool;
  for (const b of ui.tools.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tool === tool);
  canvas.style.cursor = ['measure', 'road', 'port', 'airport'].includes(tool) ? 'copy' : 'crosshair';
  updateMobileBar();
}

function setRadius(r) {
  state.radius = Math.min(Number(ui.radius.max), Math.max(Number(ui.radius.min), r));
  ui.radius.value = ui.mRadius.value = state.radius;
  ui.radiusOut.textContent = ui.mRadiusOut.textContent = formatDistance(state.radius * METERS_PER_UNIT);
}

function setStrength(s) {
  state.strength = s;
  ui.strength.value = ui.mStrength.value = s;
  ui.strengthOut.textContent = ui.mStrengthOut.textContent = Math.round(s * 100) + ' %';
}

function updateHistoryButtons() {
  ui.undo.disabled = !undoStack.length;
  ui.redo.disabled = !redoStack.length;
  ui.toolBar.querySelector('[data-action="undo"]').disabled = !undoStack.length;
  ui.toolBar.querySelector('[data-action="redo"]').disabled = !redoStack.length;
}

const ZONE_KM = formatDistance(terrain.size * METERS_PER_UNIT);
let landArea = 0;
function updateStats() {
  landArea = terrain.landArea();
}

function updateHud() {
  const parts = [];
  if (hasHit) parts.push(`Altitude <b>${formatAltitude(hit.y)}</b>`);
  parts.push(`Terres <b>${landArea.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km²</b>`);
  const { trees, buildings } = props.stats;
  const count = (n, one, many) => `<b>${n.toLocaleString('fr-FR')}</b> ${n > 1 ? many : one}`;
  const { vehicles, boats } = traffic.stats;
  // Sur petit écran, on garde l'essentiel.
  if (trees && !touchUI) parts.push(count(trees, 'arbre', 'arbres'));
  if (buildings && !touchUI) parts.push(count(buildings, 'bâtiment', 'bâtiments'));
  if (vehicles) parts.push(count(vehicles, 'véhicule', 'véhicules'));
  if (boats) parts.push(count(boats, 'bateau', 'bateaux'));
  if (towns.list.length) parts.push(count(towns.list.length, 'ville', 'villes'));
  if (airports.list.length) parts.push(count(airports.list.length, 'aéroport', 'aéroports'));
  if (flights.stats.planes) parts.push(count(flights.stats.planes, 'avion', 'avions'));
  if (!touchUI) parts.push(`Zone ${ZONE_KM} × ${ZONE_KM}`);
  // Aides au clavier / à la souris (sur mobile, la barre contextuelle les remplace).
  if (!touchUI) {
    if (mapView.active) parts.push('Vue carte · Glisser : déplacer · Molette : zoom · Clic sur un nom : renommer · M / Échap : revenir');
    else if (state.tool === 'measure') parts.push('Clic : point · ⌫ : retirer · Échap : effacer');
    else if (state.tool === 'road') parts.push('Clic : point (s\'accroche aux routes : carrefour) · Double-clic / Entrée : valider · ⌫ : retirer · Échap : annuler · Maj+clic : supprimer un tronçon (surligné en rouge)');
    else if (state.tool === 'port') parts.push('Clic sur une côte : placer un port · Maj+clic : supprimer');
    else if (state.tool === 'airport') parts.push('Clic : piste orientée automatiquement · Glisser : tracer la piste · Maj+clic : supprimer (le terrain est aplani)');
  }
  const html = parts.join(' · ');
  if (html !== ui.hud.innerHTML) ui.hud.innerHTML = html;
}

let toastTimer;
function toast(msg, isError = false) {
  ui.toast.textContent = msg;
  ui.toast.classList.toggle('error', isError);
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

const islandName = () => ui.name.value.trim() || 'Île sans nom';
const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'ile';

let renderToken = 0;
async function renderSaves() {
  const token = ++renderToken;
  let saves;
  try {
    saves = await storage.listSaves();
  } catch (err) {
    console.error(err);
    saves = [];
    toast('Sauvegardes inaccessibles : ' + err.message, true);
  }
  if (token !== renderToken) return; // une liste plus récente est en cours
  ui.saves.replaceChildren();
  if (!saves.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aucune sauvegarde pour le moment.';
    ui.saves.append(li);
    return;
  }
  for (const s of saves) {
    const li = document.createElement('li');
    li.classList.toggle('current', s.id === state.currentId);
    li.title = 'Charger cette île';
    const img = Object.assign(document.createElement('img'), { alt: '' });
    if (s.thumb) img.src = s.thumb;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = s.name;
    const small = document.createElement('small');
    small.textContent = new Date(s.updatedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    meta.append(b, small);
    const del = Object.assign(document.createElement('button'), { className: 'del', textContent: '✕', title: 'Supprimer' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Double clic de confirmation plutôt qu'une boîte de dialogue.
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Suppr. ?';
        setTimeout(() => {
          del.classList.remove('confirm');
          del.textContent = '✕';
        }, 2500);
        return;
      }
      try {
        await storage.deleteSave(s.id);
      } catch (err) {
        toast('Échec de la suppression : ' + err.message, true);
        return;
      }
      if (state.currentId === s.id) state.currentId = null;
      renderSaves();
      scheduleAutosave();
      toast(`« ${s.name} » supprimée`);
    });
    li.addEventListener('click', () => loadSave(s.id));
    li.append(img, meta, del);
    ui.saves.append(li);
  }
}

async function save() {
  try {
    const data = await serializeIsland(islandName());
    state.currentId = await storage.writeSave({ id: state.currentId, data, thumb: terrain.thumbnail() });
    state.createdAt = data.createdAt;
    renderSaves();
    scheduleAutosave();
    toast(`« ${data.name} » sauvegardée`);
  } catch (err) {
    console.error(err);
    toast('Échec de la sauvegarde : ' + err.message, true);
  }
}

const serializeIsland = (name) =>
  storage.serialize(terrain, { name, createdAt: state.createdAt, roads: roads.toJSON(), ports: ports.toJSON(), towns: towns.toJSON(), airports: airports.toJSON() });

function applyIsland({ name, createdAt, biome, heights, forest, town, fields, roads: roadData, ports: portData, towns: townData, airports: airportData }, id = null) {
  applyBiome(biome);
  terrain.setLayers({ heights, forest, town, fields });
  towns.fromJSON(townData);
  towns.update();
  roads.fromJSON(roadData);
  ports.fromJSON(portData);
  airports.fromJSON(airportData);
  rebuildNetworks();
  scheduleTraffic();
  state.currentId = id;
  state.createdAt = createdAt;
  ui.name.value = name ?? '';
  updateStats();
  renderSaves();
}

async function loadSave(id) {
  try {
    const obj = await storage.readSave(id);
    if (!obj) throw new Error('sauvegarde introuvable');
    applyIsland(await storage.deserialize(obj, terrain), id);
    undoStack.length = redoStack.length = 0;
    updateHistoryButtons();
    scheduleAutosave();
    toast(`« ${obj.name} » chargée`);
  } catch (err) {
    console.error(err);
    toast('Échec du chargement : ' + err.message, true);
  }
}

// Autosauvegarde de la session en cours (récupérée au rechargement de la page).
let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try {
      const data = await serializeIsland(ui.name.value.trim());
      await storage.writeAutosave({ currentId: state.currentId, data });
    } catch (err) {
      console.warn('Autosauvegarde impossible', err);
    }
  }, 800);
}

ui.tools.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]');
  if (b) setTool(b.dataset.tool);
});
ui.radius.addEventListener('input', () => setRadius(Number(ui.radius.value)));
ui.strength.addEventListener('input', () => setStrength(Number(ui.strength.value)));
ui.undo.addEventListener('click', () => stepHistory(undoStack, redoStack));
ui.redo.addEventListener('click', () => stepHistory(redoStack, undoStack));
ui.name.addEventListener('input', scheduleAutosave);
ui.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.name.blur();
});
ui.biome.addEventListener('change', () => {
  applyBiome(ui.biome.value);
  ui.biome.blur();
  scheduleAutosave();
});
$('save').addEventListener('click', save);

// Météo
function toggleClock() {
  weather.running = !weather.running;
  ui.clockPlay.textContent = weather.running ? '⏸ Pause' : '▶ Reprendre';
}
ui.clockPlay.addEventListener('click', () => {
  toggleClock();
  ui.clockPlay.blur();
});
ui.clock.addEventListener('input', () => (weather.hours = Number(ui.clock.value) % 24));
ui.dayLength.addEventListener('change', () => {
  weather.dayLength = Number(ui.dayLength.value);
  ui.dayLength.blur();
});
ui.weatherMode.addEventListener('change', () => {
  weather.auto = ui.weatherMode.value === 'auto';
  if (!weather.auto) weather.clear();
  ui.weatherMode.blur();
});
ui.stormGo.addEventListener('click', () => {
  const s = weather.spawn(ui.stormType.value, { x: controls.target.x, z: controls.target.z });
  if (s) toast(`${s.def.label} en approche`);
  ui.stormGo.blur();
});

let weatherUiTimer = 0;
function updateWeatherUi(dt) {
  weatherUiTimer -= dt;
  if (weatherUiTimer > 0) return;
  weatherUiTimer = 0.25;
  if (document.activeElement !== ui.clock) ui.clock.value = weather.hours;
  ui.clockOut.textContent = weather.clock();
  const parts = [weather.status(controls.target)];
  const { held, slowed } = traffic.stats;
  if (held) parts.push(`<b>${held}</b> bateau${held > 1 ? 'x' : ''} bloqué${held > 1 ? 's' : ''} au port`);
  if (slowed) parts.push(`<b>${slowed}</b> ralenti${slowed > 1 ? 's' : ''}`);
  for (const { name, reason } of flights.closures()) parts.push(`<b>${name}</b> fermé (${reason.toLowerCase()})`);
  const { delayed, holding, diverted } = flights.stats;
  const plural = (n, one, many) => `<b>${n}</b> ${n > 1 ? many : one}`;
  if (delayed) parts.push(plural(delayed, 'vol retardé', 'vols retardés'));
  if (holding) parts.push(plural(holding, 'avion en attente', 'avions en attente'));
  if (diverted) parts.push(plural(diverted, 'vol dérouté', 'vols déroutés'));
  const html = parts.join(' · ');
  if (html !== ui.weatherStatus.innerHTML) ui.weatherStatus.innerHTML = html;
}
ui.mapView.addEventListener('click', () => {
  setMapView(!mapView.active);
  ui.mapView.blur();
});
$('new').addEventListener('click', () => {
  pushHistory();
  terrain.reset();
  roads.restore([]);
  ports.restore([]);
  towns.restore([]);
  airports.restore([]);
  state.currentId = null;
  state.createdAt = null;
  ui.name.value = '';
  renderSaves();
  afterTerrainChange();
  toast('Nouvel océan — Ctrl+Z pour revenir en arrière');
});
$('export').addEventListener('click', async () => {
  const data = await serializeIsland(islandName());
  storage.downloadJSON(data, `${slug(data.name)}.island.json`);
});
$('import').addEventListener('click', () => ui.importFile.click());
$('exportAll').addEventListener('click', async () => {
  try {
    const bundle = await storage.exportAll();
    if (!bundle.islands.length) {
      toast('Aucune île sauvegardée à exporter', true);
      return;
    }
    storage.downloadJSON(bundle, `iles-${new Date().toISOString().slice(0, 10)}.islands.json`);
  } catch (err) {
    console.error(err);
    toast("Échec de l'export : " + err.message, true);
  }
});
ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files[0];
  ui.importFile.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (storage.isBundle(obj)) {
      const n = await storage.importBundle(obj);
      renderSaves();
      toast(`${n} île${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''} aux sauvegardes`);
      return;
    }
    pushHistory();
    applyIsland(await storage.deserialize(obj, terrain));
    afterTerrainChange();
    toast(`« ${obj.name} » importée — Sauvegarder pour la garder`);
  } catch (err) {
    console.error(err);
    toast("Échec de l'import : " + err.message, true);
  }
});

// --- Interface mobile ---

// Boutons d'outils de la barre du bas, copiés depuis le panneau (entre « Gomme » et « Carte »).
{
  const before = ui.toolBar.querySelector('[data-action="map"]');
  const sep = () => Object.assign(document.createElement('div'), { className: 'sep' });
  ui.toolBar.insertBefore(sep(), before);
  for (const b of ui.tools.querySelectorAll('button[data-tool]')) {
    const m = Object.assign(document.createElement('button'), { innerHTML: b.innerHTML, title: b.title });
    m.dataset.tool = b.dataset.tool;
    ui.toolBar.insertBefore(m, before);
  }
  ui.toolBar.insertBefore(sep(), before);
}

ui.toolBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) {
    setTool(b.dataset.tool);
    return;
  }
  const action = b.dataset.action;
  if (action === 'view') setViewMode(!state.viewMode);
  else if (action === 'map') setMapView(!mapView.active);
  else if (action === 'undo') stepHistory(undoStack, redoStack);
  else if (action === 'redo') stepHistory(redoStack, undoStack);
  else if (action === 'erase') {
    state.eraseMode = !state.eraseMode;
    updateMobileBar();
  }
});

ui.ctxBar.addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (action === 'road-undo') roads.removeLastDraft();
  else if (action === 'road-cancel') roads.cancelDraft();
  else if (action === 'road-done') finishRoad();
  else if (action === 'measure-undo') measure.removeLast();
  else if (action === 'measure-clear') measure.clear();
});
ui.mRadius.addEventListener('input', () => setRadius(Number(ui.mRadius.value)));
ui.mStrength.addEventListener('input', () => setStrength(Number(ui.mStrength.value)));

function setViewMode(on) {
  state.viewMode = on;
  if (on) cancelGesture();
  updateTouchControls();
  updateMobileBar();
}

/** Un doigt : outil (rien pour la caméra), rotation en mode « Vue », déplacement en vue carte. Deux doigts : déplacer + zoomer. */
function updateTouchControls() {
  controls.touches = { ONE: mapView.active ? THREE.TOUCH.PAN : state.viewMode ? THREE.TOUCH.ROTATE : null, TWO: THREE.TOUCH.DOLLY_PAN };
}

/** Barre contextuelle selon l'outil et boutons actifs. */
function updateMobileBar() {
  if (!touchUI) return;
  const t = state.tool;
  const key = mapView.active ? 'map' : state.viewMode ? 'view' : BRUSH_TOOLS.includes(t) ? 'brush' : state.eraseMode && ['road', 'port', 'airport'].includes(t) ? `${t}-erase` : t;
  for (const c of ui.ctxBar.querySelectorAll('.ctx')) c.hidden = c.dataset.ctx !== key;
  for (const b of ui.toolBar.querySelectorAll('button')) {
    const a = b.dataset.action;
    const on = b.dataset.tool ? b.dataset.tool === t && !state.viewMode && !mapView.active : a === 'view' ? state.viewMode : a === 'erase' ? state.eraseMode : a === 'map' && mapView.active;
    b.classList.toggle('active', on);
  }
}

// Hauteur de la barre du bas : la barre d'échelle et les messages se placent au-dessus.
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', ui.mobileBar.offsetHeight + 'px')).observe(ui.mobileBar);

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
}
$('menuBtn').addEventListener('click', () => setDrawer(true));
$('drawerClose').addEventListener('click', () => setDrawer(false));
updateTouchControls();

// --- Démarrage ---

setTool(state.tool);
setRadius(state.radius);
setStrength(state.strength);
applyBiome(DEFAULT_BIOME);
updateHistoryButtons();
updateStats();

// Emplacement des sauvegardes, reprise des îles de l'ancien stockage, puis de la session en cours.
(async () => {
  const where = await storage.init();
  $('storageInfo').textContent =
    where.kind === 'server'
      ? 'Fichiers du projet (dossier saves/)'
      : `Dans ce navigateur${where.persisted ? '' : ' (peuvent être effacées avec les données du site)'} — pense à « Tout exporter » de temps en temps`;
  renderSaves();
  let migrated = { count: 0, ids: {} };
  try {
    migrated = await storage.migrateLegacy();
    if (migrated.count) {
      toast(`${migrated.count} île${migrated.count > 1 ? 's' : ''} de l'ancien stockage récupérée${migrated.count > 1 ? 's' : ''}`);
      renderSaves();
    }
  } catch (err) {
    console.warn('Migration des sauvegardes navigateur impossible', err);
  }
  let restored = await storage.readAutosave();
  if (!restored?.data) {
    restored = storage.readLegacyAutosave();
    if (restored) restored.currentId = migrated.ids[restored.currentId] ?? null;
  }
  if (!restored?.data) return;
  try {
    const island = await storage.deserialize(restored.data, terrain);
    const id = restored.currentId && (await storage.readSave(restored.currentId)) ? restored.currentId : null;
    applyIsland(island, id);
  } catch (err) {
    console.warn('Autosauvegarde illisible', err);
  }
})();

// Accès console en développement.
if (import.meta.env.DEV) window.app = { terrain, props, camera, controls, measure, roads, ports, towns, traffic, weather, airports, flights, applyBiome, afterTerrainChange, setMapView };

// --- Vue carte : caméra à la verticale, noms des villes ---

const EDIT_BUTTONS = controls.mouseButtons;
const MAP_BUTTONS = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
const WATER_ROUGHNESS = water.material.roughness;
const MAP_ANIM = 0.6; // secondes

function setMapView(on) {
  if (on === mapView.active) return;
  mapView.active = on;
  ui.mapView.classList.toggle('active', on);
  roads.cancelDraft();
  cancelTownEdit();
  const from = { pos: camera.position.clone(), target: controls.target.clone() };
  let to;
  if (on) {
    mapView.saved = from;
    // Nord en haut : caméra à peine décalée vers +z pour fixer l'orientation.
    const target = new THREE.Vector3(controls.target.x, 0, controls.target.z);
    const dist = Math.max(40, camera.position.distanceTo(controls.target));
    to = { pos: target.clone().add(new THREE.Vector3(0, dist, 0.001)), target };
    weather.mapMode = true;
    water.material.roughness = 0.6; // pas de reflet du soleil en vue du dessus
  } else {
    // Retour à l'angle d'avant, au-dessus de l'endroit regardé sur la carte.
    const offset = mapView.saved.pos.clone().sub(mapView.saved.target);
    const target = new THREE.Vector3(controls.target.x, mapView.saved.target.y, controls.target.z);
    to = { pos: target.clone().add(offset), target };
    weather.mapMode = false;
    water.material.roughness = WATER_ROUGHNESS;
    Object.assign(controls, { minPolarAngle: 0, maxPolarAngle: Math.PI * 0.47, enableRotate: true, mouseButtons: EDIT_BUTTONS });
  }
  mapView.anim = { from, to, t: 0 };
  controls.enableDamping = false;
  updateTouchControls();
  updateMobileBar();
}

function animateCamera(dt) {
  const a = mapView.anim;
  if (!a) return;
  a.t = Math.min(1, a.t + dt / MAP_ANIM);
  const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - (-2 * a.t + 2) ** 2 / 2;
  camera.position.lerpVectors(a.from.pos, a.to.pos, e);
  controls.target.lerpVectors(a.from.target, a.to.target, e);
  if (a.t < 1) return;
  mapView.anim = null;
  controls.enableDamping = true;
  if (mapView.active) {
    Object.assign(controls, { minPolarAngle: 0, maxPolarAngle: 0, enableRotate: false, mouseButtons: MAP_BUTTONS });
  }
}

const labelEls = new Map(); // entrée de nom → élément
let townEdit = null; // { entry, el, input }
const _v = new THREE.Vector3();

function labelElement(entry, historyKey) {
  const el = document.createElement('div');
  el.historyKey = historyKey;
  el.className = 'town-label';
  el.title = 'Renommer';
  el.append(Object.assign(document.createElement('span'), { className: 'name' }));
  el.addEventListener('click', () => startTownEdit(entry, el));
  ui.townLabels.append(el);
  return el;
}

function startTownEdit(entry, el) {
  if (townEdit?.el === el) return;
  cancelTownEdit();
  const input = Object.assign(document.createElement('input'), { type: 'text', value: entry.name, maxLength: 40 });
  input.size = Math.max(6, entry.name.length + 2);
  el.querySelector('.name').hidden = true;
  el.append(input);
  townEdit = { entry, el, input };
  el.measured = false;
  input.addEventListener('input', () => {
    input.size = Math.max(6, input.value.length + 2);
    el.measured = false;
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finishTownEdit(true);
    else if (e.key === 'Escape') finishTownEdit(false);
  });
  input.addEventListener('blur', () => finishTownEdit(true));
  input.focus();
  input.select();
}

function finishTownEdit(keep) {
  if (!townEdit) return;
  const { entry, el, input } = townEdit;
  townEdit = null;
  const name = input.value.trim().replace(/\s+/g, ' ');
  input.remove();
  el.querySelector('.name').hidden = false;
  el.measured = false;
  if (keep && name && name !== entry.name) {
    const before = entry.name;
    commitHistory(snapshot([el.historyKey]));
    entry.name = name;
    scheduleAutosave();
    toast(`« ${before} » s'appelle maintenant « ${name} »`);
  }
}

const cancelTownEdit = () => finishTownEdit(false);

/** Place les noms (les plus grandes villes d'abord) en masquant ceux qui se chevauchent. */
function updateTownLabels() {
  ui.townLabels.hidden = !mapView.active || !!mapView.anim;
  if (ui.townLabels.hidden) return;
  // Aéroports d'abord (prioritaires), puis les villes de la plus grande à la plus petite.
  const items = [
    ...airports.list.map((a) => ({ entry: a, x: (a.x1 + a.x2) / 2, z: (a.z1 + a.z2) / 2, size: flights.closed.has(a) ? 'airport closed' : 'airport', key: 'airports' })),
    ...towns.list.map((t) => ({ entry: t.entry, x: t.x, z: t.z, size: t.area >= 1 ? 'city' : t.area >= 0.25 ? 'town' : 'village', key: 'towns' })),
  ];
  const placed = [];
  const seen = new Set();
  for (const { entry, x: wx, z: wz, size, key } of items) {
    seen.add(entry);
    const el = labelEls.get(entry) ?? labelEls.set(entry, labelElement(entry, key)).get(entry);
    if (el.dataset.size !== size) {
      el.className = 'town-label ' + size;
      el.dataset.size = size;
      el.measured = false;
    }
    const span = el.querySelector('.name');
    if (span.textContent !== entry.name) {
      span.textContent = entry.name;
      el.measured = false;
    }
    if (!el.measured) {
      el.w = el.offsetWidth;
      el.h = el.offsetHeight;
      el.measured = true;
    }
    _v.set(wx, Math.max(terrain.heightAt(wx, wz), 0), wz).project(camera);
    const x = ((_v.x + 1) / 2) * window.innerWidth;
    const y = ((1 - _v.y) / 2) * window.innerHeight;
    const box = { l: x - el.w / 2 - 6, r: x + el.w / 2 + 6, t: y - el.h / 2 - 3, b: y + el.h / 2 + 3 };
    const onScreen = _v.z < 1 && box.r > 0 && box.l < window.innerWidth && box.b > 0 && box.t < window.innerHeight;
    const free = !placed.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
    const visible = townEdit?.el === el || (onScreen && free);
    el.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) continue;
    placed.push(box);
    el.style.transform = `translate(${Math.round(x - el.w / 2)}px, ${Math.round(y - el.h / 2)}px)`;
  }
  for (const [entry, el] of labelEls) {
    if (seen.has(entry)) continue;
    if (townEdit?.el === el) cancelTownEdit();
    el.remove();
    labelEls.delete(entry);
  }
}

// Barre d'échelle : longueur « ronde » (1, 2, 5 x 10^n m) d'environ 120 px au point visé.
let scaleKey = '';
function updateScaleBar() {
  const dist = camera.position.distanceTo(controls.target);
  const metersPerPx = ((2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight) * METERS_PER_UNIT;
  const target = 120 * metersPerPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= target) ?? pow;
  const key = nice + ':' + Math.round(nice / metersPerPx);
  if (key === scaleKey) return;
  scaleKey = key;
  ui.scalebar.style.setProperty('--w', Math.round(nice / metersPerPx) + 'px');
  ui.scalebar.textContent = formatDistance(nice);
}

function showLabel(html) {
  ui.measureLabel.style.display = html ? 'block' : 'none';
  if (!html) return;
  if (html !== ui.measureLabel.innerHTML) ui.measureLabel.innerHTML = html;
  ui.measureLabel.style.left = screen.x + 'px';
  ui.measureLabel.style.top = screen.y + 'px';
}

const HEIGHT_TOOLS = ['raise', 'lower', 'smooth', 'flatten'];
let lastDrape = 0;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  animateCamera(dt);
  controls.update();
  pick();

  const tool = mapView.active || state.viewMode ? null : state.tool;
  const erase = erasing() && isZoneTool(tool);
  if (state.painting && hasHit) {
    applyBrush(terrain, {
      tool,
      erase: erasing(),
      x: hit.x,
      z: hit.z,
      radius: state.radius,
      strength: state.strength,
      dt,
      target: state.flattenTarget,
    });
    props.markDirty();
    // Routes et ports suivent le relief pendant qu'on sculpte (au plus 4 fois par seconde).
    const now = performance.now();
    if (HEIGHT_TOOLS.includes(tool) && now - lastDrape > 250) {
      rebuildNetworks();
      lastDrape = now;
    }
  }
  // Pendant un coup de pinceau, on régénère les objets au plus 4 fois par seconde.
  props.update(terrain, { throttle: state.painting ? 250 : 0 });
  weather.update(dt, controls.target, camera);
  props.setLightsLevel(weather.lightsLevel);
  traffic.setLightsLevel(weather.lightsLevel);
  airports.setLightsLevel(weather.lightsLevel);
  flights.setLightsLevel(weather.lightsLevel);
  traffic.update(dt, weather);
  flights.update(dt, weather);
  updateWeatherUi(dt);

  cursor.visible = hasHit && (BRUSH_TOOLS.includes(tool) || tool === 'port');
  if (cursor.visible) {
    if (tool === 'port') {
      updateCursor(hit, 1.5, erasing() ? ERASE_COLOR : 0x66d9ff);
    } else {
      const color = erase ? ERASE_COLOR : TOOL_COLORS[erasing() && tool === 'raise' ? 'lower' : erasing() && tool === 'lower' ? 'raise' : tool];
      updateCursor(hit, state.radius, color);
    }
  }

  if (tool === 'measure') {
    showLabel(measure.update(hasHit ? hit : null));
  } else if (tool === 'airport') {
    const c = airportCandidate();
    airports.updatePreview(c, c && !airports.check(c));
    showLabel(c && state.airportStart ? `Piste : <b>${formatDistance(Math.hypot(c.x2 - c.x1, c.z2 - c.z1) * METERS_PER_UNIT)}</b>` : null);
  } else if (tool === 'road') {
    // Maj (hors tracé en cours) : on vise le tronçon à supprimer au lieu de tracer.
    const deleting = erasing() && !roads.draft.length;
    roads.updateHighlight(deleting && hasHit ? hit : null);
    const len = roads.updatePreview(hasHit && !deleting ? hit : null);
    showLabel(len ? `Route : <b>${formatDistance(len * METERS_PER_UNIT)}</b>` : null);
  } else {
    showLabel(null);
  }
  updateHud();
  updateScaleBar();
  updateTownLabels();

  renderer.render(scene, camera);
});

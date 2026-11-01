import * as THREE from 'three';

/**
 * Météo : cycle jour/nuit et perturbations.
 *
 * Une perturbation est une zone circulaire qui traverse la carte (nuages, pluie ou neige, éclairs,
 * brouillard). Son effet est maximal au centre et s'estompe vers le bord ; `effectAt` le traduit en
 * ralentissement des véhicules et des bateaux, et en fermeture des ports.
 *
 * Le temps est accéléré : par défaut une journée dure 6 minutes.
 */

export const PERTURBATIONS = {
  thunderstorm: {
    label: 'Orage', precip: 'rain', amount: 1, clouds: 0x8d939b, darkness: 0.65, wind: 9, lightning: true,
    radius: [55, 85], speed: [4, 6], car: 0.45, boat: 0.3, closeAbove: 0.75, airClose: 0.5, fog: 0.5,
  },
  tropicalStorm: {
    label: 'Tempête tropicale', precip: 'rain', amount: 1.5, clouds: 0x9ba1a9, darkness: 0.75, wind: 16, lightning: true,
    spiral: true, radius: [100, 140], speed: [3, 4.5], car: 0.25, boat: 0.1, closeAbove: 0.35, airClose: 0.25, fog: 0.65,
  },
  shower: {
    label: 'Averse', precip: 'rain', amount: 0.6, clouds: 0xb3b8be, darkness: 0.35, wind: 4,
    radius: [35, 60], speed: [4, 7], car: 0.75, boat: 0.75, closeAbove: 2, airClose: 2, fog: 0.25,
  },
  rain: {
    label: 'Pluie', precip: 'rain', amount: 0.7, clouds: 0xa3a9b0, darkness: 0.45, wind: 5,
    radius: [70, 110], speed: [3, 5], car: 0.65, boat: 0.65, closeAbove: 2, airClose: 2, fog: 0.35,
  },
  blizzard: {
    label: 'Tempête de neige', precip: 'snow', amount: 1.4, clouds: 0xc6cbd1, darkness: 0.55, wind: 12,
    radius: [80, 120], speed: [3, 5], car: 0.12, boat: 0.25, closeAbove: 0.5, airClose: 0.35, fog: 0.85,
  },
  snow: {
    label: 'Chute de neige', precip: 'snow', amount: 0.7, clouds: 0xd6dadf, darkness: 0.3, wind: 3,
    radius: [60, 100], speed: [2, 4], car: 0.5, boat: 0.7, closeAbove: 2, airClose: 0.8, fog: 0.4,
  },
  fog: {
    label: 'Brouillard', precip: null, amount: 0, clouds: 0xe8ecef, darkness: 0.15, wind: 1, fogBank: true,
    radius: [70, 120], speed: [0.6, 1.2], car: 0.5, boat: 0.35, closeAbove: 2, airClose: 0.55, fog: 1,
  },
};

const BIOME_PERTURBATIONS = {
  temperate: ['thunderstorm', 'rain', 'fog'],
  tropical: ['tropicalStorm', 'shower'],
  icelandic: ['blizzard', 'snow', 'fog'],
  taiga: ['blizzard', 'snow', 'fog'],
  mediterranean: ['thunderstorm', 'shower', 'fog'],
};

const ZONE_HALF = 200;
const CLOUD_BASE = 42;
const RAMP = 8; // secondes de montée / descente en intensité
const AUTO_DELAY = [60, 180]; // secondes entre deux perturbations automatiques
const MAX_STORMS = 3;
const BASE_FOG = { near: 700, far: 2800 };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const rand = (a, b) => a + Math.random() * (b - a);
const _c = new THREE.Color();

// --- Précipitations : particules animées entièrement dans le shader ---

const PRECIP_VERTEX = /* glsl */ `
  uniform float uTime, uRadius, uHeight, uFall, uLen, uSize, uSnow;
  uniform vec2 uWind;
  attribute float aEnd;
  attribute float aSeed;
  varying float vFade;
  void main() {
    float y = uHeight - mod(uTime * uFall + aSeed * uHeight, uHeight);
    float fallen = uHeight - y;
    // Dérive due au vent pendant la chute, centrée sur la colonne.
    vec2 drift = uWind * (fallen - uHeight * 0.5) / uFall;
    if (uSnow > 0.5) drift += vec2(sin(uTime * 1.3 + aSeed * 40.0), cos(uTime * 1.1 + aSeed * 31.0)) * 0.8;
    vec3 p = vec3(position.x + drift.x, y, position.z + drift.y);
    if (aEnd > 0.5) p -= vec3(uWind.x, -uFall, uWind.y) * (uLen / uFall);
    vFade = (1.0 - smoothstep(0.55, 1.0, length(p.xz) / uRadius)) * smoothstep(0.0, 4.0, uHeight - y);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * 300.0 / -mv.z, 1.0, 6.0);
  }
`;

const PRECIP_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity, uSnow;
  varying float vFade;
  void main() {
    float a = uOpacity * vFade;
    if (uSnow > 0.5) a *= 1.0 - smoothstep(0.3, 0.5, length(gl_PointCoord - 0.5));
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function precipitation(def, radius) {
  const snow = def.precip === 'snow';
  const count = Math.min(40000, Math.round(((snow ? 9000 : 14000) * def.amount * radius * radius) / (80 * 80)));
  const per = snow ? 1 : 2;
  const pos = new Float32Array(count * per * 3);
  const end = new Float32Array(count * per);
  const seed = new Float32Array(count * per);
  for (let i = 0; i < count; i++) {
    const r = radius * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const s = Math.random();
    for (let k = 0; k < per; k++) {
      const j = i * per + k;
      pos[j * 3] = Math.cos(a) * r;
      pos[j * 3 + 2] = Math.sin(a) * r;
      end[j] = k;
      seed[j] = s;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: PRECIP_VERTEX,
    fragmentShader: PRECIP_FRAGMENT,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: radius },
      uHeight: { value: CLOUD_BASE },
      uFall: { value: snow ? 5 : 28 },
      uLen: { value: snow ? 0 : 1.1 },
      uSize: { value: snow ? 1.1 : 0 },
      uSnow: { value: snow ? 1 : 0 },
      uWind: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color(snow ? 0xffffff : 0xb8c6d4) },
      uOpacity: { value: 0 },
    },
  });
  const obj = snow ? new THREE.Points(g, material) : new THREE.LineSegments(g, material);
  obj.frustumCulled = false;
  return obj;
}

// --- Rideau de précipitation : voile translucide sous le nuage, visible de loin ---

const VEIL_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    vY = position.y;
    gl_Position = projectionMatrix * mv;
  }
`;

const VEIL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity, uHeight;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    // Plus opaque au milieu de la silhouette (on traverse plus de pluie), transparent sur les bords.
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float a = uOpacity * pow(facing, 1.5) * (0.55 + 0.45 * (1.0 - vY / uHeight));
    gl_FragColor = vec4(uColor, a);
  }
`;

function veil(def, radius) {
  const snow = def.precip === 'snow';
  const g = new THREE.CylinderGeometry(radius * 0.62, radius * 0.75, CLOUD_BASE, 40, 1, true).translate(0, CLOUD_BASE / 2, 0);
  const material = new THREE.ShaderMaterial({
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(snow ? 0xf2f5f8 : 0x8d98a4) },
      uOpacity: { value: 0 },
      uHeight: { value: CLOUD_BASE },
    },
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.userData.opacity = Math.min(0.5, (snow ? 0.32 : 0.22) * def.amount);
  return mesh;
}

// --- Brouillard : bouffées douces (opaques au centre, invisibles sur leur pourtour) ---

const FOG_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FOG_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    gl_FragColor = vec4(uColor, uOpacity * pow(facing, 2.5));
  }
`;

// --- Nuages : bouffées (icosaèdres aplatis) ---

const PUFF = new THREE.IcosahedronGeometry(1, 2);

function clouds(def, radius) {
  const fogBank = !!def.fogBank;
  const n = Math.round((fogBank ? 70 : 75) * (radius / 80) ** 1.5);
  const material = fogBank
    ? new THREE.ShaderMaterial({
        vertexShader: FOG_VERTEX,
        fragmentShader: FOG_FRAGMENT,
        transparent: true,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color(def.clouds) }, uOpacity: { value: 0 } },
      })
    : new THREE.MeshStandardMaterial({
        color: def.clouds,
        roughness: 1,
        transparent: true,
        opacity: 0,
        emissive: 0xffffff,
        emissiveIntensity: 0,
      });
  const mesh = new THREE.InstancedMesh(PUFF, material, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    let r;
    let a;
    if (def.spiral) {
      // Bras spiralés autour d'un œil dégagé.
      const t = Math.random();
      r = radius * (0.14 + 0.86 * t);
      a = (i % 3) * ((Math.PI * 2) / 3) + t * 4.2 + rand(-0.35, 0.35);
    } else {
      r = radius * 0.85 * Math.sqrt(Math.random());
      a = Math.random() * Math.PI * 2;
    }
    const size = fogBank ? rand(14, 26) : rand(8, 15) * (def.spiral ? 1.3 : 1);
    p.set(Math.cos(a) * r, fogBank ? rand(1, 5) : CLOUD_BASE + rand(0, 6), Math.sin(a) * r);
    s.set(size, fogBank ? rand(2, 4) : size * rand(0.3, 0.45), size * rand(0.7, 1));
    q.setFromEuler(e.set(0, Math.random() * Math.PI, 0));
    mesh.setMatrixAt(i, m.compose(p, q, s));
  }
  mesh.castShadow = !fogBank;
  mesh.frustumCulled = false;
  return mesh;
}

export class Weather {
  constructor({ scene, sun, hemi }) {
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.storms = [];
    this.hours = 10;
    this.running = true;
    this.dayLength = 360; // secondes pour 24 h
    this.auto = true;
    this.nextAuto = rand(...AUTO_DELAY) / 2;
    this.time = 0;
    this.mapMode = false;
    this.flash = 0;
    this.night = 0;
    this.biomeId = 'temperate';
    this.skyDay = new THREE.Color();

    this.stars = this.makeStars();
    scene.add(this.stars);

    // Éclair : ligne brisée, visible une fraction de seconde.
    this.bolt = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2 * 40), 3)),
      new THREE.LineBasicMaterial({ color: 0xeaf2ff, transparent: true, fog: false }),
    );
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    scene.add(this.bolt);
  }

  makeStars() {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Hémisphère haut, loin.
      const u = Math.random();
      const a = Math.random() * Math.PI * 2;
      const y = 0.08 + 0.92 * u;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * r * 5000, y * 5000, Math.sin(a) * r * 5000], i * 3);
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    stars.frustumCulled = false;
    return stars;
  }

  setBiome(biome) {
    this.biomeId = biome.id;
    this.skyDay.setHex(biome.sky);
  }

  /** Perturbations possibles dans le biome courant. */
  types() {
    return (BIOME_PERTURBATIONS[this.biomeId] ?? BIOME_PERTURBATIONS.temperate).map((id) => ({ id, label: PERTURBATIONS[id].label }));
  }

  /** Lance une perturbation qui passera par `through` (ou un point au hasard de la zone). */
  spawn(type, through = null) {
    const def = PERTURBATIONS[type];
    if (!def) return null;
    if (this.storms.length >= MAX_STORMS) this.storms[0].leaving = true;
    const radius = rand(...def.radius);
    const speed = rand(...def.speed);
    const angle = Math.random() * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const target = through ?? { x: rand(-120, 120), z: rand(-120, 120) };
    // Le brouillard se forme sur place ; les autres arrivent de l'extérieur de la zone.
    const back = def.fogBank ? 0 : ZONE_HALF + radius - 40;
    const storm = {
      type,
      def,
      radius,
      x: target.x - dx * back,
      z: target.z - dz * back,
      vx: dx * speed,
      vz: dz * speed,
      wind: new THREE.Vector2(dx, dz).multiplyScalar(def.wind),
      age: 0,
      life: def.fogBank ? rand(90, 150) : Infinity,
      intensity: 0,
      leaving: false,
      nextStrike: rand(1, 4),
      group: new THREE.Group(),
      spin: def.spiral ? 0.06 : 0.01,
    };
    storm.cloud = clouds(def, radius);
    storm.group.add(storm.cloud);
    if (def.precip) {
      storm.precip = precipitation(def, radius);
      storm.veil = veil(def, radius);
      storm.group.add(storm.precip, storm.veil);
    }
    storm.group.position.set(storm.x, 0, storm.z);
    this.scene.add(storm.group);
    this.storms.push(storm);
    return storm;
  }

  clear() {
    for (const s of this.storms) s.leaving = true;
  }

  dispose(storm) {
    this.scene.remove(storm.group);
    storm.cloud.material.dispose();
    for (const obj of [storm.precip, storm.veil]) {
      if (!obj) continue;
      obj.geometry.dispose();
      obj.material.dispose();
    }
  }

  /** Intensité locale (0..1) d'une perturbation en (x, z). */
  local(storm, x, z) {
    const d = Math.hypot(x - storm.x, z - storm.z) / storm.radius;
    return storm.intensity * (1 - smooth(0.55, 1, d));
  }

  /**
   * Effet de la météo en un point : facteurs de vitesse (1 = normal) des véhicules et des bateaux,
   * agitation (0..1), fermeture des ports et des aéroports (avec la perturbation en cause).
   */
  effectAt(x, z, out = {}) {
    out.car = 1;
    out.boat = 1;
    out.rough = 0;
    out.closed = false;
    out.airClosed = false;
    out.airReason = null;
    for (const s of this.storms) {
      const k = this.local(s, x, z);
      if (k <= 0) continue;
      out.car = Math.min(out.car, 1 - (1 - s.def.car) * k);
      out.boat = Math.min(out.boat, 1 - (1 - s.def.boat) * k);
      out.rough = Math.max(out.rough, k * Math.min(1, s.def.wind / 12));
      if (k > s.def.closeAbove) out.closed = true;
      if (k > s.def.airClose && !out.airClosed) {
        out.airClosed = true;
        out.airReason = s.def.label;
      }
    }
    return out;
  }

  /** Texte d'état pour le panneau, vu depuis `focus`. */
  status(focus) {
    if (!this.storms.length) return 'Temps calme';
    return this.storms
      .filter((s) => s.intensity > 0.05)
      .map((s) => {
        const d = Math.max(0, Math.hypot(s.x - focus.x, s.z - focus.z) - s.radius * 0.55);
        const where = d < 1 ? 'ici' : `à ${(d * 0.05).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
        return `${s.def.label} ${where}`;
      })
      .join(' · ') || 'Temps calme';
  }

  clock() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt, focus, camera = null) {
    this.time += dt;
    if (this.running) this.hours = (this.hours + (dt * 24) / this.dayLength) % 24;

    if (this.auto) {
      this.nextAuto -= dt;
      if (this.nextAuto <= 0) {
        const types = this.types();
        this.spawn(types[Math.floor(Math.random() * types.length)].id);
        this.nextAuto = rand(...AUTO_DELAY);
      }
    }

    for (const s of [...this.storms]) {
      s.age += dt;
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      const out = Math.max(Math.abs(s.x), Math.abs(s.z)) > ZONE_HALF + s.radius + 60 && s.age > 10;
      if (out || s.age > s.life) s.leaving = true;
      s.intensity = Math.min(1, Math.max(0, s.intensity + (s.leaving ? -dt : dt) / RAMP));
      if (s.leaving && s.intensity <= 0) {
        this.dispose(s);
        this.storms.splice(this.storms.indexOf(s), 1);
        continue;
      }
      s.group.position.set(s.x, 0, s.z);
      s.cloud.rotation.y += s.spin * dt;
      // Nuages estompés quand la caméra s'en approche, pour ne pas masquer l'île.
      const near = camera ? Math.hypot(camera.position.x - s.x, camera.position.y - CLOUD_BASE, camera.position.z - s.z) / (s.radius * 1.6) : 1;
      const base = s.def.fogBank ? 0.42 : 0.78 * (0.35 + 0.65 * smooth(0.3, 1, near));
      // En vue carte, la perturbation se lit comme sur un radar sans masquer la carte.
      const opacity = base * (this.mapMode ? 0.5 : 1) * s.intensity;
      if (s.def.fogBank) {
        // Le brouillard prend la teinte de la lumière ambiante (gris bleuté la nuit).
        const u = s.cloud.material.uniforms;
        u.uOpacity.value = opacity * 1.6;
        u.uColor.value.setHex(0x3a4558).lerp(_c.setHex(s.def.clouds), 1 - this.night);
      } else {
        s.cloud.material.opacity = opacity;
      }
      if (s.veil) s.veil.material.uniforms.uOpacity.value = s.veil.userData.opacity * s.intensity;
      if (s.precip) {
        const u = s.precip.material.uniforms;
        u.uTime.value = this.time;
        u.uWind.value.copy(s.wind);
        u.uOpacity.value = (s.def.precip === 'snow' ? 0.9 : 0.45) * s.intensity;
      }
      if (s.def.lightning && s.intensity > 0.6) {
        s.nextStrike -= dt;
        if (s.nextStrike <= 0) {
          this.strike(s, focus);
          s.nextStrike = rand(0.8, 5);
        }
      }
      if (!s.def.fogBank) s.cloud.material.emissiveIntensity = s.flash ? 0.6 : 0;
      s.flash = Math.max(0, (s.flash ?? 0) - dt);
    }

    this.flash = Math.max(0, this.flash - dt);
    this.bolt.visible = this.flash > 0.05;
    this.bolt.material.opacity = Math.min(1, this.flash * 8);
    this.applyLighting(focus);
  }

  /** Éclair : ligne brisée du nuage au sol, et flash d'autant plus fort que l'orage est proche. */
  strike(storm, focus) {
    const r = storm.radius * 0.6 * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    let x = storm.x + Math.cos(a) * r;
    let z = storm.z + Math.sin(a) * r;
    const pos = this.bolt.geometry.attributes.position;
    const steps = 12;
    let y = CLOUD_BASE;
    for (let k = 0; k < steps; k++) {
      const ny = CLOUD_BASE * (1 - (k + 1) / steps);
      const nx = x + rand(-1.6, 1.6);
      const nz = z + rand(-1.6, 1.6);
      pos.setXYZ(k * 2, x, y, z);
      pos.setXYZ(k * 2 + 1, nx, ny, nz);
      [x, y, z] = [nx, ny, nz];
    }
    pos.needsUpdate = true;
    this.bolt.geometry.setDrawRange(0, steps * 2);
    const near = 1 - smooth(storm.radius * 0.5, storm.radius * 2.5, Math.hypot(focus.x - storm.x, focus.z - storm.z));
    this.flash = 0.18 + 0.12 * Math.random();
    this.flashPower = 0.4 + 1.8 * near;
    storm.flash = 0.12;
  }

  applyLighting(focus) {
    // Soleil : lever à 6 h à l'est (+x), coucher à 18 h à l'ouest.
    const a = ((this.hours - 6) / 12) * Math.PI;
    const dir = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.95, 0.35).normalize();
    const elev = dir.y;
    const day = smooth(-0.08, 0.22, elev);
    const dusk = (1 - smooth(0.05, 0.35, Math.abs(elev))) * smooth(-0.15, 0.05, elev);
    this.night = 1 - day;

    // Assombrissement par la perturbation la plus présente au point regardé.
    let dark = 0;
    let fog = 0;
    for (const s of this.storms) {
      const k = this.local(s, focus.x, focus.z);
      dark = Math.max(dark, k * s.def.darkness);
      fog = Math.max(fog, k * s.def.fog);
    }

    const sun = this.sun;
    if (elev >= 0) {
      sun.position.copy(dir).multiplyScalar(450);
      sun.color.setHex(0xff9a5a).lerp(_c.setHex(0xfff1d6), smooth(0.02, 0.4, elev));
      sun.intensity = 2.4 * day * (1 - 0.8 * dark);
    } else {
      // La nuit, la même lumière fait office de lune, à l'opposé.
      sun.position.copy(dir).multiplyScalar(-450);
      sun.color.setHex(0x9fb4ff);
      sun.intensity = 0.9 * smooth(0.0, 0.2, -elev) * (1 - 0.8 * dark);
    }

    const flash = this.flash > 0 ? this.flashPower * (this.flash / 0.3) : 0;
    this.hemi.intensity = (0.35 + 0.55 * day) * (1 - 0.35 * dark) + flash;
    this.hemi.color.setHex(0x6a7cb0).lerp(_c.setHex(0xdff3ff), day);
    this.hemi.groundColor.setHex(0x10151c).lerp(_c.setHex(0x3a5a40), day);

    const sky = this.scene.background;
    sky.setHex(0x0a1020).lerp(this.skyDay, day);
    sky.lerp(_c.setHex(0xf09a68), dusk * 0.55);
    sky.lerp(_c.setHex(0x4e555d).multiplyScalar(0.25 + 0.75 * day), dark * 0.85);
    if (flash) sky.lerp(_c.setHex(0xdfe8ff), Math.min(0.6, flash * 0.3));

    const f = this.scene.fog;
    f.color.copy(sky);
    if (this.mapMode) {
      f.near = f.far = 1e6;
    } else {
      f.near = BASE_FOG.near * (1 - 0.95 * fog);
      f.far = BASE_FOG.far * (1 - 0.88 * fog);
    }

    this.stars.material.opacity = smooth(0.4, 0.95, this.night) * (1 - Math.min(1, dark * 1.5));
    // Éclairage artificiel : la nuit, et un peu sous un ciel très sombre.
    this.lightsLevel = Math.max(smooth(0.35, 0.8, this.night), smooth(0.4, 0.7, dark) * 0.6);
  }
}

import * as THREE from 'three';

/**
 * Biomes. Hauteurs en unités monde (1 unité = 50 m).
 * - land : paliers [hauteur, couleur] interpolés, le premier étant le rivage ;
 *   sous le rivage, dégradé depuis `deep`.
 * - trees : essences possibles ({ species, w: poids, hMin, hMax }).
 * - town : style de toit et palettes de murs / toits.
 * - road : couleur des routes ; fields : palette des parcelles de champs.
 */
const DEFS = {
  temperate: {
    label: 'Tempéré',
    sky: 0x9fd3ea,
    water: 0x2386b8,
    waterOpacity: 0.72,
    deep: 0x1d4a5c,
    land: [[-0.4, 0xc9b98a], [0.5, 0xeedcae], [1.4, 0x6aa84f], [10, 0x3d7a34], [18, 0x7d756c]],
    rock: 0x7d756c,
    rockSlope: [0.3, 0.55],
    snow: 0xf4f6f8,
    snowLine: 26,
    road: 0x55524c,
    fields: [0xc9b45a, 0x8fae4a, 0x7a6a3a, 0xa8c060, 0xb9a24a],
    forestGround: 0x2e5a27,
    townGround: 0x8f8a7e,
    treeDensity: 0.9,
    treeLine: 20,
    trees: [{ species: 'deciduous', w: 0.65, hMax: 12 }, { species: 'conifer', w: 0.35 }],
    town: { roof: 'gable', walls: [0xf1ece2, 0xe6dccb, 0xd8cdb8], roofs: [0xa8442e, 0x8c3a2a, 0x6e4a3a] },
  },
  tropical: {
    label: 'Tropical',
    sky: 0xa8e2f2,
    water: 0x19b3c2,
    waterOpacity: 0.6,
    deep: 0x1a6f80,
    land: [[-0.4, 0xe9dcb4], [0.6, 0xf6ecd2], [1.3, 0x4caa4a], [6, 0x2e8a3c], [16, 0x2a6e35], [26, 0x6b6355]],
    rock: 0x6b6355,
    rockSlope: [0.45, 0.7],
    snow: 0xf4f6f8,
    snowLine: 999,
    road: 0x9a8460,
    fields: [0x5f9e3a, 0x7fb84a, 0x9aa83a, 0x6a8a30],
    forestGround: 0x1f6b2c,
    townGround: 0xc9b48a,
    treeDensity: 1.1,
    treeLine: 30,
    trees: [{ species: 'palm', w: 1, hMax: 4 }, { species: 'broadleaf', w: 1, hMin: 2 }],
    town: { roof: 'hut', walls: [0xd9c39a, 0xcbb48a, 0xe4d2ab], roofs: [0xb08a4a, 0x9c7a3e, 0xa58550] },
  },
  icelandic: {
    label: 'Islandais',
    sky: 0xc3d2da,
    water: 0x2c6a83,
    waterOpacity: 0.78,
    deep: 0x1b3b48,
    land: [[-0.4, 0x3d3a37], [0.5, 0x2c2a29], [1.2, 0x7d9150], [5, 0x66784a], [9, 0x5a5a4c], [12, 0x46423f]],
    rock: 0x3b3836,
    rockSlope: [0.2, 0.42],
    snow: 0xe9f1f6,
    snowLine: 15,
    road: 0x6a6660,
    fields: [0x9db35a, 0x8aa050, 0xa9b86a],
    forestGround: 0x4f6a3a,
    townGround: 0x6d6a66,
    treeDensity: 0.35,
    treeLine: 9,
    trees: [{ species: 'birch', w: 1 }],
    town: {
      roof: 'gable',
      walls: [0xf4f1ea, 0xc8402f, 0xe7c14a, 0x3f6f9a, 0xe9e3d6],
      roofs: [0xb2352a, 0x2f5d8a, 0x3a3a3a, 0x4b7a3c],
    },
  },
  taiga: {
    label: 'Taïga',
    sky: 0xb5cad4,
    water: 0x25596f,
    waterOpacity: 0.76,
    deep: 0x18394a,
    land: [[-0.4, 0x8f8a80], [0.5, 0xa49f93], [1.2, 0x5a7340], [6, 0x40593a], [14, 0x5c5b52]],
    rock: 0x6f6a66,
    rockSlope: [0.3, 0.55],
    snow: 0xf1f4f6,
    snowLine: 19,
    road: 0x6b6255,
    fields: [0x8a9a4a, 0xa89a5a, 0x6f7a3a, 0x7d8a45],
    forestGround: 0x23402a,
    townGround: 0x77705f,
    treeDensity: 1.3,
    treeLine: 17,
    trees: [{ species: 'spruce', w: 1 }],
    town: { roof: 'gable', walls: [0x7a4a2a, 0x8b5a34, 0x6b3f24, 0x9a6a40], roofs: [0x3a3a3a, 0x5a2a20, 0x4a4a40] },
  },
  mediterranean: {
    label: 'Méditerranéen',
    sky: 0xbfe0f0,
    water: 0x1e93b8,
    waterOpacity: 0.68,
    deep: 0x1a5a72,
    land: [[-0.4, 0xd9c08c], [0.5, 0xead6a6], [1.4, 0xb9aa6a], [5, 0x8e9150], [11, 0xa08660], [20, 0x9b8770]],
    rock: 0x9b8770,
    rockSlope: [0.3, 0.6],
    snow: 0xf4f6f8,
    snowLine: 40,
    road: 0x8a7e6a,
    fields: [0xc8a860, 0x9a9a50, 0xb08a50, 0xd0b870, 0x8a8a48],
    forestGround: 0x5d6b38,
    townGround: 0xcfc3a8,
    treeDensity: 0.6,
    treeLine: 22,
    trees: [{ species: 'olive', w: 0.6, hMax: 8 }, { species: 'pine', w: 0.4 }],
    town: { roof: 'flat', walls: [0xf5f2ea, 0xefe6d6, 0xe9dcc4], roofs: [0xf0ebe0, 0xc0643c] },
  },
};

const col = (hex) => new THREE.Color(hex);

export const BIOMES = Object.fromEntries(
  Object.entries(DEFS).map(([id, d]) => [
    id,
    {
      ...d,
      id,
      deepColor: col(d.deep),
      landStops: d.land.map(([h, hex]) => ({ h, c: col(hex) })),
      rockColor: col(d.rock),
      snowColor: col(d.snow),
      forestGroundColor: col(d.forestGround),
      townGroundColor: col(d.townGround),
      fieldColors: d.fields.map(col),
    },
  ]),
);

export const DEFAULT_BIOME = 'temperate';

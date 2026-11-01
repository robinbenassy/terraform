import { hash } from './util.js';

/**
 * Noms de villes générés, dans le style du biome (toponymes plausibles, pas des lieux réels).
 * Chaque style combine un préfixe facultatif, une racine et une terminaison.
 */
const STYLES = {
  temperate: {
    pre: ['', '', '', '', 'Saint-', 'Le ', 'La '],
    root: ['Beau', 'Mont', 'Roche', 'Clair', 'Bois', 'Val', 'Fonte', 'Marais', 'Haut', 'Bel', 'Chêne', 'Pierre', 'Lan', 'Ker'],
    end: ['mont', 'ville', 'court', 'bourg', 'lieu', 'fort', 'val', 'ac', 'ière', 'ay', 'oux'],
  },
  tropical: {
    pre: ['', '', '', 'Port ', 'Baie '],
    root: ['Ka', 'Mo', 'Ha', 'Ta', 'Pu', 'Ma', 'Le', 'Hi', 'Na', 'Fa', 'Ra', 'Vai'],
    mid: ['la', 'ko', 'nu', 'pa', 'ri', 'te', 'ho', 'mai', 'lu', 'wa', 'e'],
    end: ['a', 'i', 'u', 'o', 'ea', 'ani', 'iti', 'nui'],
  },
  icelandic: {
    pre: [''],
    root: ['Reyk', 'Hafn', 'Sel', 'Grind', 'Borg', 'Stykk', 'Akur', 'Hús', 'Dal', 'Vest', 'Ólafs', 'Breið', 'Sauð', 'Skaga'],
    end: ['vík', 'fjörður', 'nes', 'eyri', 'höfn', 'holt', 'staðir', 'foss', 'vogur', 'ey'],
  },
  taiga: {
    pre: ['', '', '', 'Ust-', 'Verkh-'],
    root: ['Novo', 'Krasno', 'Belo', 'Lesno', 'Kamen', 'Ozer', 'Sosno', 'Kedro', 'Ivan', 'Severo', 'Yeni', 'Tor'],
    end: ['gorsk', 'ovo', 'insk', 'ka', 'grad', 'yarsk', 'sk', 'ino', 'mysk', 'avsk'],
  },
  mediterranean: {
    pre: ['', '', '', 'San ', 'Santa ', 'Porto ', 'Cala '],
    root: ['Mar', 'Bel', 'Ros', 'Cal', 'Ser', 'Mon', 'Vil', 'Ter', 'Pal', 'Cor', 'Lim', 'Agr'],
    end: ['ino', 'ella', 'ano', 'ara', 'ezzo', 'ona', 'ia', 'esi', 'ossa', 'eto'],
  },
};

const pick = (arr, r) => arr[Math.floor(r * arr.length)];
const VOWELS = 'aeiouyáàâäéèêëíïîóôöúûüù';

/** Accole deux morceaux en évitant les rencontres de voyelles (« Novo » + « ovo » → « Novovo »). */
const join = (a, b) => (VOWELS.includes(a.at(-1)) && VOWELS.includes(b[0]) ? a.slice(0, -1) + b : a + b);
const awkward = new RegExp(`[${VOWELS}]{3}`, 'i');

/** Nom déterministe pour une graine donnée, absent de `used`. */
export function townName(biome, seed, used = new Set()) {
  const style = STYLES[biome] ?? STYLES.temperate;
  for (let attempt = 0; attempt < 50; attempt++) {
    const r = (k) => hash(seed, attempt, k);
    let body = pick(style.root, r(1));
    if (style.mid && r(2) < 0.7) body = join(body, pick(style.mid, r(3)));
    body = join(body, pick(style.end, r(4)));
    const name = pick(style.pre, r(5)) + body;
    if (body.length >= 4 && !awkward.test(body) && !used.has(name)) return name;
  }
  return `Ville ${used.size + 1}`;
}

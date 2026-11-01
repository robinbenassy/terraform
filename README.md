# Terraformeur d'îles

Éditeur three.js pour sculpter des îles au pinceau.

```sh
npm install
npm run dev     # http://localhost:5179
```

## Contrôles

| Action | Entrée |
| --- | --- |
| Peindre | clic gauche (maintenu) |
| Inverser élever/abaisser | Maj |
| Tourner / déplacer / zoom | clic droit / clic molette / molette |
| Outils | 1 Élever · 2 Abaisser · 3 Lisser · 4 Aplatir |
| Forêt / Ville / Champs | 5 / 6 / 7 (Maj : gommer la zone) |
| Route | 8 — clic : point · double-clic ou Entrée : valider · Retour arrière : retirer · Échap : annuler · Maj+clic : supprimer le tronçon surligné en rouge (entre deux carrefours). Commencer sur l'extrémité d'une route la prolonge ; un point posé sur une route (repère jaune) ou un croisement crée un carrefour |
| Port | 9 — clic sur une côte · Maj+clic : supprimer |
| Mesure | 0 — clic : ajouter un point · Retour arrière : retirer · Échap : effacer |
| Aéroport | A — clic : piste orientée automatiquement (aperçu au survol) · glisser : tracer la piste · Maj+clic : supprimer. Le terrain est aplani sous l'emprise |
| Vue carte | M (ou bouton « Vue carte ») — vue du dessus avec les noms des villes · glisser : déplacer · molette : zoom · clic sur un nom : renommer · M / Échap : revenir |
| Temps | T : pause / reprise · panneau « Météo » : heure, durée d'une journée, perturbations automatiques ou aucune, « Déclencher » une perturbation sur la zone regardée |
| Rayon du pinceau | `[` `]` |
| Annuler / rétablir | Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z) |
| Sauvegarder | Ctrl+S |

## Sur mobile / tablette

Sur un petit écran ou un écran tactile, l'interface s'adapte : le panneau devient un menu (☰), les outils passent dans une barre en bas avec, au-dessus, les réglages de l'outil (rayon et force, boutons Valider / Annuler pour les routes…).

| Geste | Effet |
| --- | --- |
| Un doigt | utiliser l'outil (peindre, poser un point, un port, un aéroport) |
| Deux doigts | déplacer et zoomer (un geste commencé à un doigt est alors annulé) |
| Bouton ✋ Vue | un doigt fait tourner la vue |
| Bouton ⌫ Gomme | équivaut à Maj : inverser, gommer, supprimer |
| Vue carte | un doigt déplace la carte, toucher un nom le renomme |

Le rendu est allégé (résolution et ombres) pour rester fluide.

## Structure

Échelle : 1 unité = 50 m (horizontal et vertical). Zone éditable 400×400 unités = 20×20 km, grille 513×513.

- `src/terrain.js` — heightmap + couches de zones (forêt, ville), géométrie, normales, couleurs selon le biome, raycast sur le heightfield, vignette.
- `src/biomes.js` — définition des biomes (couleurs, eau, ciel, essences, style de bâtiments).
- `src/brush.js` — outils du pinceau (relief et zones).
- `src/props.js` — génération procédurale des arbres et bâtiments (InstancedMesh) à partir des zones.
- `src/roads.js` — routes (Catmull-Rom drapée sur le relief ; au-dessus de l'eau, pont avec rampes d'accès, piles et garde-corps) et réseau déduit des croisements (carrefours = nœuds, tronçons = arêtes).
- `src/ports.js` — ports (ponton vers l'eau profonde, entrepôt, fanal).
- `src/traffic.js` — véhicules de ville en ville sur le réseau routier (plus court chemin entre carrefours), bateaux entre ports d'îles différentes (Dijkstra sur grille d'eau).
- `src/towns.js` — villes (zones de ville connexes) et leurs noms, rattachés par une ancre qui suit la ville.
- `src/names.js` — noms de villes générés dans le style du biome.
- `src/airports.js` — aéroports : piste, taxiway, aire de stationnement, aérogare, tour, hangar, balisage ; choix automatique de l'orientation, aplanissement du terrain.
- `src/flights.js` — avions entre aéroports (roulage, décollage, croisière au-dessus du relief, finale dans l'axe, atterrissage) ; fermeture par la météo : vols retardés, déroutés ou en circuit d'attente, turbulences.
- `src/weather.js` — cycle jour/nuit (soleil, lune, ciel, étoiles, éclairage artificiel) et perturbations mobiles adaptées au biome (orage, pluie, averse, tempête tropicale, tempête de neige, chute de neige, brouillard) : nuages, précipitations animées dans un shader, éclairs ; effets sur la circulation et la navigation (`effectAt`).
- `src/util.js` — hash, géométries colorées, chemins échantillonnés, composantes connexes.
- `src/measure.js` — outil de mesure (distance à plat, au sol, dénivelé).
- `src/storage.js` — format de fichier, sauvegardes (via l'API du serveur), autosauvegarde, export, migration de l'ancien stockage navigateur.
- `saves-plugin.js` — plugin Vite qui lit et écrit les sauvegardes dans `saves/` (`npm run dev` et `npm run preview`).
- `src/main.js` — scène, saisie, historique, interface.

## Sauvegarde

- **Où ?** En local (`npm run dev` / `npm run preview`), dans les fichiers du projet ; sur un site statique (GitHub Pages…), dans le navigateur (IndexedDB). L'application choisit seule, et le panneau « Sauvegardes » indique l'emplacement.
- **Tout exporter** : toutes les îles dans un seul fichier `.islands.json` ; **Importer** l'accepte (les îles sont ajoutées aux sauvegardes). Indispensable en ligne : les données du navigateur peuvent être effacées.
- **Sauvegarder** (en local) : un fichier par île dans `saves/` (`<nom-de-l-ile>.island.json`, avec vignette), listé dans le panneau. Le fichier suit le nom de l'île ; une île supprimée part dans `saves/.corbeille/`.
- Les îles de l'ancien stockage navigateur (localStorage) sont copiées dans `saves/` au premier lancement.
- **Exporter / Importer** : fichier `.island.json` (format v3 : hauteurs int16 + zones uint8 compressées en gzip puis base64, routes, ports, noms des villes et aéroports en JSON). Les anciennes versions restent lisibles ; la v1 (zone de 200) est recentrée à l'import.
- La session en cours est autosauvegardée (`saves/.autosave.json`) et restaurée au rechargement de la page.

## Mise en ligne (GitHub Pages)

1. Créer un dépôt GitHub (par ex. `iles`) et y pousser le projet (`saves/` est exclu par `.gitignore`).
2. Dans le dépôt : **Settings → Pages → Source : GitHub Actions**.
3. Chaque push sur `main` (ou `master`) compile et publie le jeu (`.github/workflows/pages.yml`) à l'adresse `https://<utilisateur>.github.io/<dépôt>/`.

En ligne, les îles sont gardées dans le navigateur du joueur : penser à « Tout exporter » de temps en temps.

import { defineConfig } from 'vite';
import { savesPlugin } from './saves-plugin.js';

export default defineConfig({
  // Chemins relatifs : le site compilé fonctionne aussi dans un sous-dossier (GitHub Pages).
  base: './',
  plugins: [savesPlugin({ dir: 'saves' })],
  // Port fixe : l'ancien stockage navigateur (localStorage, migré vers saves/) dépend de l'origine.
  server: { port: 5179, strictPort: true, watch: { ignored: ['**/saves/**'] } },
  preview: { port: 5179, strictPort: true },
});

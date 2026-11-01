import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Plugin Vite : les sauvegardes sont des fichiers du projet (dossier `saves/`), servis par une petite API.
 *
 *   GET    /api/saves            liste [{ id, name, updatedAt, thumb }]
 *   GET    /api/saves/:id        contenu d'une île
 *   POST   /api/saves            crée une île → { id }
 *   PUT    /api/saves/:id        met à jour une île → { id } (renommée si son nom a changé)
 *   DELETE /api/saves/:id        déplace le fichier dans saves/.corbeille/
 *   GET    /api/autosave         session en cours (ou null)
 *   PUT    /api/autosave
 *
 * Un id est le nom du fichier sans « .island.json », dérivé du nom de l'île.
 */

const EXT = '.island.json';
const ID = /^[a-z0-9][a-z0-9-]*$/;

const slug = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'ile';

export function savesPlugin({ dir = 'saves' } = {}) {
  let root;
  const file = (id) => path.join(root, id + EXT);
  const autosaveFile = () => path.join(root, '.autosave.json');
  const exists = (p) => fs.access(p).then(() => true, () => false);

  async function writeAtomic(p, text) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, p);
  }

  async function freeId(name, current) {
    const base = slug(name);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (id === current || !(await exists(file(id)))) return id;
    }
  }

  async function list() {
    await fs.mkdir(root, { recursive: true });
    const out = [];
    for (const f of await fs.readdir(root)) {
      if (!f.endsWith(EXT)) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(root, f), 'utf8'));
        out.push({ id: f.slice(0, -EXT.length), name: data.name, updatedAt: data.updatedAt, thumb: data.thumb ?? null });
      } catch {
        // Fichier illisible : ignoré dans la liste.
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function handle(req, res, next) {
    const url = new URL(req.url, 'http://x');
    const send = (status, value) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      if (url.pathname === '/api/autosave') {
        if (req.method === 'GET') {
          return send(200, (await exists(autosaveFile())) ? JSON.parse(await fs.readFile(autosaveFile(), 'utf8')) : null);
        }
        if (req.method === 'PUT') {
          await writeAtomic(autosaveFile(), JSON.stringify(await body(req)));
          return send(200, { ok: true });
        }
      }
      if (url.pathname === '/api/saves') {
        if (req.method === 'GET') return send(200, await list());
        if (req.method === 'POST') {
          const data = await body(req);
          const id = await freeId(data.name);
          await writeAtomic(file(id), JSON.stringify(data));
          return send(200, { id });
        }
      }
      const m = url.pathname.match(/^\/api\/saves\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!ID.test(id)) return send(400, { error: 'id invalide' });
        if (req.method === 'GET') {
          if (!(await exists(file(id)))) return send(404, { error: 'introuvable' });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.end(await fs.readFile(file(id)));
        }
        if (req.method === 'PUT') {
          const data = await body(req);
          // Le fichier suit le nom de l'île.
          const target = await freeId(data.name, id);
          await writeAtomic(file(target), JSON.stringify(data));
          if (target !== id && (await exists(file(id)))) await fs.rm(file(id));
          return send(200, { id: target });
        }
        if (req.method === 'DELETE') {
          if (await exists(file(id))) {
            const trash = path.join(root, '.corbeille');
            await fs.mkdir(trash, { recursive: true });
            await fs.rename(file(id), path.join(trash, `${id}.${Date.now()}${EXT}`));
          }
          return send(200, { ok: true });
        }
      }
      if (url.pathname.startsWith('/api/')) return send(404, { error: 'route inconnue' });
      next();
    } catch (err) {
      send(500, { error: err.message });
    }
  }

  return {
    name: 'islands-saves',
    configResolved(config) {
      root = path.resolve(config.root, dir);
    },
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

/**
 * Server locale per sviluppo e collaudo.
 *
 * Mette insieme le due metà che in produzione stanno su Vercel: i file statici
 * prodotti da Vite e il router applicativo. Serve a lavorare e a verificare i
 * flussi senza dipendere da un servizio esterno; non è il runtime di produzione.
 *
 *   npm run build && node scripts/dev-server.mjs
 *
 * Variabili utili:
 *   DATABASE_URL=postgres://...   connessione al database
 *   DATABASE_SSL=disable          per un PostgreSQL locale senza TLS
 *   PORT=3000                     porta di ascolto
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '@legendforge/server';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const staticRoot = join(root, 'apps', 'web', 'dist');
const port = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
};

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: { code: 'invalid_json', message: "Corpo della richiesta non è JSON valido" },
        }),
      );
      return;
    }

    const response = await handleRequest({
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname.replace(/\/+$/u, '') || '/',
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body,
    });

    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    for (const [key, value] of Object.entries(response.headers ?? {})) res.setHeader(key, value);
    res.end(JSON.stringify(response.body));
    return;
  }

  // File statici, con ricaduta su index.html per le rotte dell'applicazione.
  const requested = normalize(join(staticRoot, decodeURIComponent(url.pathname)));
  let filePath = requested.startsWith(staticRoot) ? requested : staticRoot;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(staticRoot, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Non trovato');
  }
});

server.listen(port, () => {
  console.log(`LegendForge in ascolto su http://127.0.0.1:${port}`);
});

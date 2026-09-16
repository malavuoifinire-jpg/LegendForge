import { readEnv, type ServerEnv } from './env.js';
import { getPool, type DatabasePool } from './db.js';
import { createRouter, errorBody, type AppRequest, type AppResponse, type Router } from './http.js';
import { runMigrations, type MigrationOutcome } from './migrations/run.js';
import { healthRoutes } from './routes/health.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { sessionRoutes } from './routes/session.js';
import { campaignRoutes } from './routes/campaigns.js';
import type { ServerContext } from './context.js';

/**
 * Stato delle migrazioni per processo.
 *
 * In ambiente serverless lo stesso processo serve più richieste: il tentativo
 * viene fatto una volta sola e il risultato è visibile nel controllo di stato.
 */
let migrationOutcome: MigrationOutcome | null = null;
let migrationPromise: Promise<void> | null = null;

async function ensureMigrations(env: ServerEnv, pool: DatabasePool | null): Promise<void> {
  if (!pool || !env.autoMigrate) return;
  if (!migrationPromise) {
    migrationPromise = runMigrations(pool).then((outcome) => {
      migrationOutcome = outcome;
    });
  }
  await migrationPromise;
}

export function createApp(env: ServerEnv, pool: DatabasePool | null): Router {
  const routes = [...healthRoutes(env, pool, () => migrationOutcome), ...diagnosticsRoutes(env)];

  // Le rotte che toccano i dati esistono solo se c'è un database configurato.
  if (pool) {
    const context: ServerContext = { env, pool };
    routes.push(...sessionRoutes(context), ...campaignRoutes(context));
  }

  return createRouter(routes);
}

let cachedApp: Router | null = null;
let cachedEnv: ServerEnv | null = null;

/** Punto di ingresso unico usato dall'adattatore del runtime. */
export async function handleRequest(request: AppRequest): Promise<AppResponse> {
  if (!cachedEnv) cachedEnv = readEnv();
  const env = cachedEnv;
  const pool = getPool(env);

  try {
    await ensureMigrations(env, pool);
  } catch (error) {
    migrationOutcome = {
      ok: false,
      applied: [],
      total: 0,
      error: error instanceof Error ? error.message : 'errore sconosciuto',
    };
  }

  // Lo schema non allineato non deve rendere muto il controllo di stato: è
  // proprio lì che si legge il motivo del problema.
  const alwaysAvailable = request.path === '/api/health' || request.path.startsWith('/api/diagnostics/');
  if (migrationOutcome && !migrationOutcome.ok && !alwaysAvailable) {
    return {
      status: 503,
      body: errorBody('schema_unavailable', 'Lo schema del database non è pronto'),
    };
  }

  if (!cachedApp) cachedApp = createApp(env, pool);
  return cachedApp.handle(request);
}

/** Usato dai test per ripartire da zero. */
export function resetAppCache(): void {
  cachedApp = null;
  cachedEnv = null;
  migrationOutcome = null;
  migrationPromise = null;
}

import { API_SCHEMA_VERSION, type Health } from '@legendforge/contracts';
import { getPool } from '../db.js';
import type { ServerEnv } from '../env.js';
import type { Route } from '../http.js';

interface DatabaseProbe {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  migrationsApplied: number | null;
  error: string | null;
}

/**
 * Verifica reale della connessione al database.
 *
 * Non è un valore finto: esegue una query e riporta latenza, versione del
 * server e numero di migrazioni applicate. Se la tabella delle migrazioni non
 * esiste ancora, il conteggio è null — non zero, che significherebbe un'altra
 * cosa.
 */
async function probeDatabase(env: ServerEnv): Promise<DatabaseProbe> {
  const pool = getPool(env);
  if (!pool) {
    return {
      configured: false,
      reachable: false,
      latencyMs: null,
      serverVersion: null,
      migrationsApplied: null,
      error: 'DATABASE_URL non configurata',
    };
  }

  const startedAt = Date.now();
  try {
    const { rows } = await pool.query<{ version: string }>('SELECT version() AS version');
    const latencyMs = Date.now() - startedAt;
    const serverVersion = rows[0]?.version ?? null;

    let migrationsApplied: number | null = null;
    try {
      const migrations = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM schema_migrations',
      );
      migrationsApplied = migrations.rows[0]?.count ?? 0;
    } catch {
      // La tabella non esiste ancora: nessuna migrazione è stata applicata.
      migrationsApplied = null;
    }

    return {
      configured: true,
      reachable: true,
      latencyMs,
      serverVersion: serverVersion ? serverVersion.split(' on ')[0] ?? serverVersion : null,
      migrationsApplied,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      latencyMs: null,
      serverVersion: null,
      migrationsApplied: null,
      error: error instanceof Error ? error.message : 'errore sconosciuto',
    };
  }
}

export function healthRoutes(env: ServerEnv): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/health',
      async handle() {
        const database = await probeDatabase(env);
        const body: Health = {
          status: database.reachable ? 'ok' : 'degraded',
          apiSchemaVersion: API_SCHEMA_VERSION,
          serverTime: new Date().toISOString(),
          build: env.build,
          region: env.region,
          database,
        };
        return {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
          body,
        };
      },
    },
  ];
}

import { API_SCHEMA_VERSION, type Health } from '@legendforge/contracts';
import type { DatabasePool } from '../db.js';
import type { ServerEnv } from '../env.js';
import type { Route } from '../http.js';
import type { MigrationOutcome } from '../migrations/run.js';
import { MIGRATIONS } from '../migrations/index.js';

interface DatabaseProbe {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  migrationsApplied: number | null;
  error: string | null;
}

/**
 * Verifica reale della connessione: esegue una query e riporta latenza,
 * versione del server e migrazioni registrate. Se la tabella delle migrazioni
 * non esiste, il conteggio è null — non zero, che significherebbe altro.
 */
async function probeDatabase(pool: DatabasePool | null): Promise<DatabaseProbe> {
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
    const raw = rows[0]?.version ?? null;

    let migrationsApplied: number | null = null;
    try {
      const migrations = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM schema_migrations',
      );
      migrationsApplied = migrations.rows[0]?.count ?? 0;
    } catch {
      migrationsApplied = null;
    }

    return {
      configured: true,
      reachable: true,
      latencyMs,
      serverVersion: raw ? (raw.split(' on ')[0] ?? raw) : null,
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

export function healthRoutes(
  env: ServerEnv,
  pool: DatabasePool | null,
  migrations: () => MigrationOutcome | null,
): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/health',
      async handle() {
        const database = await probeDatabase(pool);
        const outcome = migrations();
        const body: Health = {
          status: database.reachable && (outcome?.ok ?? false) ? 'ok' : 'degraded',
          apiSchemaVersion: API_SCHEMA_VERSION,
          serverTime: new Date().toISOString(),
          build: env.build,
          region: env.region,
          database,
          migrations: {
            expected: MIGRATIONS.length,
            appliedNow: outcome?.applied ?? [],
            ok: outcome?.ok ?? false,
            error: outcome?.error ?? (outcome ? null : 'migrazioni non ancora eseguite'),
          },
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },
  ];
}

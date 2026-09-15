import type { DatabasePool } from '../db.js';
import { MIGRATIONS } from './index.js';

export interface MigrationOutcome {
  ok: boolean;
  applied: string[];
  total: number;
  error: string | null;
}

// Chiave arbitraria ma stabile: identifica il lock delle migrazioni di questa
// applicazione, così due istanze che partono insieme non si sovrappongono.
const ADVISORY_LOCK_KEY = 831_204_771;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * Applica le migrazioni non ancora eseguite.
 *
 * Tutto avviene in una sola transazione protetta da un lock a livello di
 * transazione: è la forma compatibile con un pooler in modalità transazione,
 * dove la connessione può cambiare fra un comando e l'altro. Se qualcosa
 * fallisce non resta applicata nemmeno una parte.
 */
export async function runMigrations(pool: DatabasePool): Promise<MigrationOutcome> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(CREATE_TABLE);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((row) => row.name));

    for (const migration of MIGRATIONS) {
      if (done.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
      applied.push(migration.name);
    }

    await client.query('COMMIT');
    return { ok: true, applied, total: MIGRATIONS.length, error: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return {
      ok: false,
      applied: [],
      total: MIGRATIONS.length,
      error: error instanceof Error ? error.message : 'errore sconosciuto',
    };
  } finally {
    client.release();
  }
}

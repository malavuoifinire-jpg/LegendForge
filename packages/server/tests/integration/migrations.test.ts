import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPoolForTests } from './pool.js';
import { TEST_ENV } from './helpers.js';
import { runMigrations } from '../../src/migrations/run.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import type { DatabasePool } from '../../src/db.js';

let pool: DatabasePool;

beforeAll(() => {
  pool = createPoolForTests(TEST_ENV);
});

afterAll(async () => {
  await pool.end();
});

describe('migrazioni', () => {
  it('sono idempotenti: una seconda esecuzione non applica nulla', async () => {
    const first = await runMigrations(pool);
    expect(first.ok).toBe(true);

    const second = await runMigrations(pool);
    expect(second.ok).toBe(true);
    expect(second.applied).toEqual([]);
  });

  it('registrano ogni migrazione prevista dal codice', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    for (const migration of MIGRATIONS) {
      expect(applied.has(migration.name)).toBe(true);
    }
  });

  it('possono essere eseguite in parallelo senza rompersi', async () => {
    const outcomes = await Promise.all([
      runMigrations(pool),
      runMigrations(pool),
      runMigrations(pool),
    ]);
    for (const outcome of outcomes) expect(outcome.ok).toBe(true);
  });

  it('creano le tabelle attese', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.map((row) => row.table_name));
    for (const expected of [
      'users',
      'sessions',
      'instance_state',
      'campaigns',
      'campaign_memberships',
      'assets',
      'map_assets',
      'scenes',
      'grid_configurations',
      'actors',
      'tokens',
      'schema_migrations',
    ]) {
      expect(tables.has(expected)).toBe(true);
    }
  });
});

import { createApp } from '../../src/app.js';
import { createPoolForTests } from './pool.js';
import { runMigrations } from '../../src/migrations/run.js';
import type { AppRequest, AppResponse, Router } from '../../src/http.js';
import type { ServerEnv } from '../../src/env.js';
import { SESSION_COOKIE } from '../../src/identity/cookies.js';
import type { DatabasePool } from '../../src/db.js';

export const TEST_ENV: ServerEnv = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: (process.env.DATABASE_SSL as ServerEnv['databaseSsl']) ?? 'disable',
  autoMigrate: false,
  build: 'test',
  region: null,
  nodeEnv: 'test',
};

export interface TestHarness {
  pool: DatabasePool;
  app: Router;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<TestHarness> {
  const pool = createPoolForTests(TEST_ENV);
  const outcome = await runMigrations(pool);
  if (!outcome.ok) throw new Error(`migrazioni fallite: ${outcome.error}`);
  const app = createApp(TEST_ENV, pool);

  return {
    pool,
    app,
    async reset() {
      // instance_state ha una chiave esterna verso users, quindi CASCADE la
      // svuota insieme alle altre: la riga singola va ricreata, altrimenti i
      // test partirebbero da uno stato che in produzione non esiste.
      await pool.query(`
        TRUNCATE tokens, actors, grid_configurations, scenes, map_assets, assets,
                 campaign_memberships, campaigns, sessions, instance_state, users
        RESTART IDENTITY CASCADE`);
      await pool.query('INSERT INTO instance_state (id) VALUES (true) ON CONFLICT DO NOTHING');
    },
    async close() {
      await pool.end();
    },
  };
}

export function request(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): AppRequest {
  return {
    method,
    path,
    query: {},
    headers: {
      'user-agent': 'vitest',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body,
  };
}

/** Estrae il token di sessione da una risposta che lo ha appena emesso. */
export function sessionCookieFrom(response: AppResponse): string {
  const raw = response.headers?.['Set-Cookie'];
  if (!raw) throw new Error('nessun cookie di sessione nella risposta');
  const value = raw.split(';')[0];
  if (!value) throw new Error('cookie malformato');
  return value;
}

export function cookieHeader(token: string): string {
  return token.startsWith(SESSION_COOKIE) ? token : `${SESSION_COOKIE}=${token}`;
}

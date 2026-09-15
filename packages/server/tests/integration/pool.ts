import pg from 'pg';
import type { ServerEnv } from '../../src/env.js';

/**
 * I test usano un pool proprio invece di quello memorizzato dal modulo: ogni
 * file di test deve poter aprire e chiudere le proprie connessioni.
 */
export function createPoolForTests(env: ServerEnv): pg.Pool {
  return new pg.Pool({
    connectionString: env.databaseUrl,
    max: 4,
    ssl: env.databaseSsl === 'disable' ? false : { rejectUnauthorized: env.databaseSsl === 'require' },
  });
}

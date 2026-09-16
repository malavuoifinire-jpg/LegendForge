import { rootCertificates } from 'node:tls';
import pg from 'pg';
import type { ServerEnv } from './env.js';
import { SUPABASE_CA_BUNDLE } from './supabase-ca.js';

/**
 * Le autorità pubbliche più quella di Supabase.
 *
 * Passando `ca` a Node si sostituisce l'intero deposito: aggiungiamo la radice
 * di Supabase a quelle di sistema invece di rimpiazzarle, così la stessa
 * configurazione vale anche per un database ospitato altrove.
 */
const TRUSTED_AUTHORITIES = [...rootCertificates, ...SUPABASE_CA_BUNDLE];

// Gli interi a 64 bit e i numeric tornerebbero come stringhe: nel dominio del
// tavolo virtuale non usiamo valori fuori dal range sicuro di JavaScript.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number.parseFloat(value));

export type DatabasePool = pg.Pool;

/**
 * In ambiente serverless lo stesso processo serve più richieste: il pool va
 * creato una volta sola e riusato, non aperto e chiuso a ogni invocazione.
 */
let cachedPool: DatabasePool | null = null;
let cachedUrl: string | null = null;

export function getPool(env: ServerEnv): DatabasePool | null {
  if (!env.databaseUrl) return null;
  if (cachedPool && cachedUrl === env.databaseUrl) return cachedPool;
  cachedPool = new pg.Pool({
    connectionString: env.databaseUrl,
    // Il pooler in modalità transazione non gradisce molte connessioni per
    // istanza: ogni invocazione serverless ne apre poche e le riusa.
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl:
      env.databaseSsl === 'disable'
        ? false
        : env.databaseSsl === 'insecure'
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true, ca: TRUSTED_AUTHORITIES },
  });
  cachedPool.on('error', () => {
    // Una connessione inattiva caduta non deve abbattere il processo.
  });
  cachedUrl = env.databaseUrl;
  return cachedPool;
}

/** Usato dai test per ripartire da zero. */
export function resetPoolCache(): void {
  cachedPool = null;
  cachedUrl = null;
}

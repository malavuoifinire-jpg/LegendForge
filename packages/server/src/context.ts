import type { Viewer } from '@legendforge/contracts';
import type { DatabasePool } from './db.js';
import type { ServerEnv } from './env.js';
import { HttpError, type AppRequest } from './http.js';
import { parseCookies, SESSION_COOKIE } from './identity/cookies.js';
import { hashToken } from './identity/secrets.js';

/** Dipendenze condivise da tutti i casi d'uso. */
export interface ServerContext {
  env: ServerEnv;
  pool: DatabasePool;
}

export function requirePool(env: ServerEnv, pool: DatabasePool | null): DatabasePool {
  if (!pool) {
    throw new HttpError(503, 'database_unavailable', 'Il database non è configurato');
  }
  void env;
  return pool;
}

interface SessionRow {
  user_id: string;
  display_name: string;
  owner_user_id: string | null;
}

/**
 * Risolve chi sta facendo la richiesta a partire dal cookie di sessione.
 *
 * Restituisce null quando non c'è sessione, è scaduta o è stata revocata: la
 * distinzione fra i tre casi non viene esposta al client.
 */
export async function resolveViewer(
  context: ServerContext,
  request: AppRequest,
): Promise<Viewer | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const { rows } = await context.pool.query<SessionRow>(
    `SELECT s.user_id, u.display_name, i.owner_user_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN instance_state i ON i.id = true
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) return null;

  // Aggiorna l'ultimo utilizzo senza bloccare la risposta.
  void context.pool
    .query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hashToken(token)])
    .catch(() => undefined);

  return {
    id: row.user_id,
    displayName: row.display_name,
    isOwner: row.owner_user_id === row.user_id,
  };
}

export async function requireViewer(
  context: ServerContext,
  request: AppRequest,
): Promise<Viewer> {
  const viewer = await resolveViewer(context, request);
  if (!viewer) throw new HttpError(401, 'unauthenticated', 'Sessione assente o scaduta');
  return viewer;
}

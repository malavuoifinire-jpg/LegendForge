import type { DatabasePool } from '../db.js';
import { hashSecret, verifySecret } from './password.js';
import { canonicalRecoveryCode, generateRecoveryCode, generateSessionToken, hashToken } from './secrets.js';

export const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

/** Soglia oltre la quale i tentativi falliti fanno scattare un blocco. */
const LOCKOUT_AFTER_ATTEMPTS = 5;
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 30 * 60;

export interface UserRow {
  id: string;
  display_name: string;
  pin_hash: string | null;
  recovery_code_hash: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

export async function isInstanceClaimed(pool: DatabasePool): Promise<boolean> {
  const { rows } = await pool.query<{ claimed: boolean }>(
    `SELECT (owner_user_id IS NOT NULL) AS claimed FROM instance_state WHERE id = true`,
  );
  return rows[0]?.claimed ?? false;
}

export async function getOwner(pool: DatabasePool): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT u.id, u.display_name, u.pin_hash, u.recovery_code_hash,
            u.failed_attempts, u.locked_until
       FROM instance_state i
       JOIN users u ON u.id = i.owner_user_id
      WHERE i.id = true`,
  );
  return rows[0] ?? null;
}

export interface ClaimResult {
  userId: string;
  displayName: string;
  recoveryCode: string;
}

/**
 * Rivendica l'istanza creando l'utente proprietario.
 *
 * L'operazione è protetta dal vincolo sulla riga singola di `instance_state`:
 * due richieste contemporanee non possono creare due proprietari.
 */
export async function claimInstance(
  pool: DatabasePool,
  displayName: string,
  pin: string,
): Promise<ClaimResult | null> {
  const recoveryCode = generateRecoveryCode();
  const [pinHash, recoveryHash] = await Promise.all([
    hashSecret(pin),
    hashSecret(canonicalRecoveryCode(recoveryCode)),
  ]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM instance_state WHERE id = true FOR UPDATE',
    );
    if (claimed.rows[0]?.owner_user_id) {
      await client.query('ROLLBACK');
      return null;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (display_name, pin_hash, recovery_code_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [displayName, pinHash, recoveryHash],
    );
    const userId = inserted.rows[0]?.id;
    if (!userId) throw new Error('creazione utente fallita');

    await client.query(
      `UPDATE instance_state
          SET owner_user_id = $1, updated_at = now(), version = version + 1
        WHERE id = true`,
      [userId],
    );
    await client.query('COMMIT');
    return { userId, displayName, recoveryCode };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface AuthAttempt {
  ok: boolean;
  userId?: string;
  /** Secondi di attesa residui quando l'account è temporaneamente bloccato. */
  lockedForSeconds?: number;
}

function lockoutSeconds(failedAttempts: number): number {
  const over = failedAttempts - LOCKOUT_AFTER_ATTEMPTS;
  if (over < 0) return 0;
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** over, LOCKOUT_MAX_SECONDS);
}

/**
 * Verifica il PIN applicando blocco progressivo.
 *
 * Il blocco è legato all'account, non all'indirizzo di rete: cambiare rete non
 * lo aggira. Il ritardo cresce a ogni tentativo fallito oltre la soglia.
 */
export async function verifyPin(pool: DatabasePool, pin: string): Promise<AuthAttempt> {
  const user = await getOwner(pool);
  if (!user) return { ok: false };

  if (user.locked_until) {
    const remaining = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
    if (remaining > 0) return { ok: false, lockedForSeconds: remaining };
  }

  const valid = await verifySecret(pin, user.pin_hash);
  if (valid) {
    await pool.query(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL,
              updated_at = now(), version = version + 1
        WHERE id = $1`,
      [user.id],
    );
    return { ok: true, userId: user.id };
  }

  const attempts = user.failed_attempts + 1;
  const seconds = lockoutSeconds(attempts);
  await pool.query(
    `UPDATE users
        SET failed_attempts = $2,
            locked_until = CASE WHEN $3 > 0 THEN now() + make_interval(secs => $3) ELSE NULL END,
            updated_at = now(), version = version + 1
      WHERE id = $1`,
    [user.id, attempts, seconds],
  );
  return { ok: false, lockedForSeconds: seconds > 0 ? seconds : undefined };
}

export async function verifyRecoveryCode(
  pool: DatabasePool,
  code: string,
): Promise<{ ok: boolean; userId?: string }> {
  const user = await getOwner(pool);
  if (!user) return { ok: false };
  const valid = await verifySecret(canonicalRecoveryCode(code), user.recovery_code_hash);
  return valid ? { ok: true, userId: user.id } : { ok: false };
}

/** Sostituisce PIN e codice di recupero, e revoca tutte le sessioni attive. */
export async function resetCredentials(
  pool: DatabasePool,
  userId: string,
  newPin: string,
): Promise<string> {
  const recoveryCode = generateRecoveryCode();
  const [pinHash, recoveryHash] = await Promise.all([
    hashSecret(newPin),
    hashSecret(canonicalRecoveryCode(recoveryCode)),
  ]);
  await pool.query(
    `UPDATE users
        SET pin_hash = $2, recovery_code_hash = $3, failed_attempts = 0, locked_until = NULL,
            updated_at = now(), version = version + 1
      WHERE id = $1`,
    [userId, pinHash, recoveryHash],
  );
  await pool.query(
    `UPDATE sessions SET revoked_at = now(), updated_at = now(), version = version + 1
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return recoveryCode;
}

export async function createSession(
  pool: DatabasePool,
  userId: string,
  userAgent: string | undefined,
): Promise<string> {
  const token = generateSessionToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4)`,
    [userId, hashToken(token), SESSION_DURATION_SECONDS, userAgent?.slice(0, 200) ?? null],
  );
  return token;
}

export async function revokeSession(pool: DatabasePool, token: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now(), updated_at = now(), version = version + 1
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

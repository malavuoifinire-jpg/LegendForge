import { randomBytes } from 'node:crypto';
import type { DatabasePool } from '../db.js';
import { hashSecret } from './password.js';
import { hashToken } from './secrets.js';

/**
 * Inviti alla campagna.
 *
 * Il link è l'unico segreto che circola: contiene 256 bit di entropia e del
 * token il database conserva soltanto l'impronta. Un invito ha un numero
 * massimo di usi, una scadenza e può essere revocato; la revoca ha effetto
 * immediato perché lo stato viene letto a ogni tentativo.
 */

export type InviteStatus = 'active' | 'exhausted' | 'expired' | 'revoked';

export interface InviteRow {
  id: string;
  campaign_id: string;
  label: string;
  max_uses: number;
  used_count: number;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  version: number;
}

export function inviteStatus(row: InviteRow): InviteStatus {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  if (row.used_count >= row.max_uses) return 'exhausted';
  return 'active';
}

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createInvite(
  pool: DatabasePool,
  campaignId: string,
  createdBy: string,
  options: { label: string; maxUses: number; expiresInHours: number | null },
): Promise<{ row: InviteRow; token: string }> {
  const token = generateInviteToken();
  const { rows } = await pool.query<InviteRow>(
    `INSERT INTO invites (campaign_id, token_hash, label, max_uses, expires_at, created_by)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(hours => $5::int) END,
             $6)
     RETURNING id, campaign_id, label, max_uses, used_count, expires_at, revoked_at,
               created_at, updated_at, version`,
    [campaignId, hashToken(token), options.label, options.maxUses, options.expiresInHours, createdBy],
  );
  const row = rows[0];
  if (!row) throw new Error('creazione invito fallita');
  return { row, token };
}

export async function findInviteByToken(
  pool: DatabasePool,
  token: string,
): Promise<InviteRow | null> {
  const { rows } = await pool.query<InviteRow>(
    `SELECT id, campaign_id, label, max_uses, used_count, expires_at, revoked_at,
            created_at, updated_at, version
       FROM invites WHERE token_hash = $1`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export interface SeatUsage {
  campaignName: string;
  playerSlots: number;
  playersJoined: number;
}

export async function seatUsage(
  pool: DatabasePool,
  campaignId: string,
): Promise<SeatUsage | null> {
  const { rows } = await pool.query<SeatUsage>(
    `SELECT c.name AS "campaignName",
            c.player_slots AS "playerSlots",
            (SELECT count(*)::int FROM campaign_memberships m
              WHERE m.campaign_id = c.id AND m.role = 'player' AND m.status = 'active')
              AS "playersJoined"
       FROM campaigns c WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [campaignId],
  );
  return rows[0] ?? null;
}

export type AcceptOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'full' | 'name_taken' };

/**
 * Consuma un invito creando il giocatore.
 *
 * Tutto avviene in una sola transazione con la riga dell'invito bloccata: due
 * persone che aprono lo stesso link nello stesso istante non possono superare
 * né gli usi previsti né i posti disponibili.
 */
export async function acceptInvite(
  pool: DatabasePool,
  token: string,
  displayName: string,
  pin: string,
): Promise<AcceptOutcome> {
  const pinHash = await hashSecret(pin);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invites = await client.query<InviteRow>(
      `SELECT id, campaign_id, label, max_uses, used_count, expires_at, revoked_at,
              created_at, updated_at, version
         FROM invites WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(token)],
    );
    const invite = invites.rows[0];
    if (!invite || inviteStatus(invite) !== 'active') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }

    const seats = await client.query<{ player_slots: number; joined: number }>(
      `SELECT c.player_slots,
              (SELECT count(*)::int FROM campaign_memberships m
                WHERE m.campaign_id = c.id AND m.role = 'player' AND m.status = 'active') AS joined
         FROM campaigns c WHERE c.id = $1 AND c.deleted_at IS NULL FOR UPDATE`,
      [invite.campaign_id],
    );
    const seat = seats.rows[0];
    if (!seat || seat.joined >= seat.player_slots) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'full' };
    }

    let userId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (display_name, pin_hash) VALUES ($1, $2) RETURNING id`,
        [displayName, pinHash],
      );
      userId = inserted.rows[0]?.id ?? '';
    } catch (error) {
      await client.query('ROLLBACK');
      // 23505: il nome visualizzato è già in uso.
      if ((error as { code?: string }).code === '23505') {
        return { ok: false, reason: 'name_taken' };
      }
      throw error;
    }
    if (!userId) throw new Error('creazione giocatore fallita');

    await client.query(
      `INSERT INTO campaign_memberships (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
      [invite.campaign_id, userId],
    );
    await client.query(
      `UPDATE invites SET used_count = used_count + 1, updated_at = now(), version = version + 1
        WHERE id = $1`,
      [invite.id],
    );
    await client.query('COMMIT');
    return { ok: true, userId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

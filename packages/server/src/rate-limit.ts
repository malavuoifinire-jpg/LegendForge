import type { DatabasePool } from './db.js';

/**
 * Limite di tentativi a finestra scorrevole, tenuto nel database.
 *
 * In un ambiente serverless non esiste memoria condivisa fra le istanze: un
 * contatore in processo proteggerebbe solo l'istanza che l'ha visto. Il
 * database è l'unico posto dove tutte le copie si incontrano.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Tentativi già consumati nella finestra corrente. */
  used: number;
  /** Secondi mancanti alla riapertura, quando il limite è stato superato. */
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  pool: DatabasePool,
  bucket: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { rows } = await pool.query<{ count: number; window_start: Date | string }>(
    `INSERT INTO rate_limits (bucket, key, window_start, count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (bucket, key) DO UPDATE
        SET count = CASE
              WHEN rate_limits.window_start < now() - make_interval(secs => $3) THEN 1
              ELSE rate_limits.count + 1
            END,
            window_start = CASE
              WHEN rate_limits.window_start < now() - make_interval(secs => $3) THEN now()
              ELSE rate_limits.window_start
            END
     RETURNING count, window_start`,
    [bucket, key, windowSeconds],
  );

  const row = rows[0];
  if (!row) return { allowed: true, used: 0, retryAfterSeconds: 0 };
  const startedAt = row.window_start instanceof Date ? row.window_start : new Date(row.window_start);
  const elapsed = (Date.now() - startedAt.getTime()) / 1000;
  return {
    allowed: row.count <= limit,
    used: row.count,
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - elapsed)),
  };
}

/** Identifica chi sta facendo i tentativi, quando non c'è ancora una sessione. */
export function clientKey(headers: Record<string, string | undefined>): string {
  const forwarded = headers['x-forwarded-for'];
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers['x-real-ip'] || 'sconosciuto';
}

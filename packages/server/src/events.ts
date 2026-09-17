import type { DatabasePool } from './db.js';

/**
 * Registro dei cambiamenti di scena.
 *
 * Ogni modifica lascia una riga con la propria visibilità già decisa: chi
 * consegna gli eventi non deve ragionare su cosa mostrare, filtra e basta. È lo
 * stesso principio della lettura completa della scena, applicato agli
 * aggiornamenti.
 */

export type EventVisibility = 'all' | 'game_master';

export type SceneEventKind =
  | 'token.upserted'
  | 'token.removed'
  | 'grid.updated'
  /**
   * Muri, luci e impostazioni di visione cambiati.
   *
   * Questi eventi non portano dati: dicono soltanto che qualcosa è cambiato, e
   * ogni client rilegge il proprio stato passando dalla propria
   * autorizzazione. Un evento destinato a tutti non può contenere la pianta di
   * una stanza che qualcuno non ha ancora visto.
   */
  | 'wall.changed'
  | 'light.changed'
  | 'vision.changed'
  | 'encounter.changed'
  | 'terrain.changed';

export interface SceneEvent {
  id: number;
  kind: SceneEventKind;
  payload: unknown;
  at: string;
}

/** Gli eventi più vecchi di questo intervallo non servono più a nessuno. */
const RETENTION_HOURS = 6;

interface Queryable {
  query: DatabasePool['query'];
}

export async function emitSceneEvent(
  db: Queryable,
  sceneId: string,
  kind: SceneEventKind,
  payload: unknown,
  visibility: EventVisibility = 'all',
): Promise<void> {
  await db.query(
    `INSERT INTO scene_events (scene_id, kind, payload, visibility) VALUES ($1, $2, $3, $4)`,
    [sceneId, kind, JSON.stringify(payload), visibility],
  );
}

export async function pruneSceneEvents(db: Queryable, sceneId: string): Promise<void> {
  await db
    .query(
      `DELETE FROM scene_events
        WHERE scene_id = $1 AND created_at < now() - make_interval(hours => $2)`,
      [sceneId, RETENTION_HOURS],
    )
    .catch(() => undefined);
}

export async function latestCursor(db: Queryable, sceneId: string): Promise<number> {
  const { rows } = await db.query<{ cursor: string | number | null }>(
    `SELECT max(id) AS cursor FROM scene_events WHERE scene_id = $1`,
    [sceneId],
  );
  const value = rows[0]?.cursor;
  return value === null || value === undefined ? 0 : Number(value);
}

export async function readSceneEvents(
  db: Queryable,
  sceneId: string,
  since: number,
  visibilities: EventVisibility[],
): Promise<SceneEvent[]> {
  const { rows } = await db.query<{
    id: string | number;
    kind: SceneEventKind;
    payload: unknown;
    created_at: Date | string;
  }>(
    `SELECT id, kind, payload, created_at
       FROM scene_events
      WHERE scene_id = $1 AND id > $2 AND visibility = ANY($3::text[])
      ORDER BY id ASC
      LIMIT 200`,
    [sceneId, since, visibilities],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    payload: row.payload,
    at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

import {
  createActorInputSchema,
  setActorOwnersInputSchema,
  updateActorInputSchema,
  type Actor,
  type ActorKind,
  type ActorVision,
} from '@legendforge/contracts';
import { requireCampaignAccess, requireGameMaster } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';

interface ActorRow {
  id: string;
  campaign_id: string;
  kind: ActorKind;
  name: string;
  size_in_cells: number;
  color: string;
  owner_user_ids: string[] | null;
  darkvision_meters: number | string;
  normal_vision_meters: number | string | null;
  special_senses: unknown;
  movement: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    kind: row.kind,
    name: row.name,
    sizeInCells: row.size_in_cells,
    color: row.color,
    ownerUserIds: row.owner_user_ids ?? [],
    vision: toActorVision(row),
    movement: toActorMovement(row.movement),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

/**
 * Sensi del personaggio letti dalla riga.
 *
 * I sensi speciali sono JSON libero sul database: qui si tiene solo quello che
 * ha la forma giusta, invece di fidarsi di com'è stato scritto.
 */
function toActorVision(row: ActorRow): ActorVision {
  const senses: ActorVision['specialSenses'] = [];
  if (Array.isArray(row.special_senses)) {
    for (const entry of row.special_senses) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : null;
      const range = typeof record.rangeMeters === 'number' ? record.rangeMeters : null;
      if (name && range !== null && Number.isFinite(range) && range >= 0) {
        senses.push({ name, rangeMeters: range });
      }
    }
  }
  return {
    normalRangeMeters:
      row.normal_vision_meters === null ? null : Number(row.normal_vision_meters),
    darkvisionMeters: Number(row.darkvision_meters),
    specialSenses: senses,
  };
}

/**
 * Velocita di un attore, per modo, in metri.
 *
 * Un modo assente significa che quella creatura non si muove cosi: un umano
 * non ha `volare`, e non e la stessa cosa che averlo a zero.
 */
function toActorMovement(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return { camminare: 9 };
  const profile: Record<string, number> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) profile[mode] = value;
  }
  return Object.keys(profile).length > 0 ? profile : { camminare: 9 };
}

const SELECT_ACTORS = `
  SELECT a.id, a.campaign_id, a.kind, a.name, a.size_in_cells, a.color,
         ARRAY(SELECT o.user_id FROM actor_ownership o WHERE o.actor_id = a.id) AS owner_user_ids,
         a.darkvision_meters, a.normal_vision_meters, a.special_senses, a.movement,
         a.created_at, a.updated_at, a.version
    FROM actors a
   WHERE a.deleted_at IS NULL`;

export function actorRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/actors',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        // Un giocatore vede i personaggi, non il bestiario del Game Master.
        const onlyCharacters = access.role !== 'game_master';
        const { rows } = await context.pool.query<ActorRow>(
          `${SELECT_ACTORS} AND a.campaign_id = $1
             ${onlyCharacters ? "AND a.kind = 'character'" : ''}
           ORDER BY a.kind, a.name`,
          [access.campaignId],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toActor) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/actors',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createActorInputSchema, request.body);
        const inserted = await context.pool.query<{ id: string }>(
          `INSERT INTO actors (campaign_id, kind, name, size_in_cells, color,
                               darkvision_meters, normal_vision_meters, special_senses, movement)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
          [
            access.campaignId,
            input.kind,
            input.name,
            input.sizeInCells,
            input.color,
            input.vision?.darkvisionMeters ?? 0,
            input.vision?.normalRangeMeters ?? null,
            JSON.stringify(input.vision?.specialSenses ?? []),
            JSON.stringify(input.movement ?? { camminare: 9 }),
          ],
        );
        const { rows } = await context.pool.query<ActorRow>(`${SELECT_ACTORS} AND a.id = $1`, [
          inserted.rows[0]?.id,
        ]);
        const row = rows[0];
        if (!row) throw new Error('attore non leggibile dopo la creazione');
        return { status: 201, body: toActor(row) };
      },
    },

    {
      /**
       * Modifica di un personaggio, sensi compresi.
       *
       * I sensi stanno qui e non nella scena: sono di chi li ha, e valgono in
       * ogni scena in cui la sua pedina compare.
       */
      method: 'PATCH',
      pattern: '/api/actors/:actorId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const actorId = params.actorId ?? '';
        const owning = await context.pool.query<{ campaign_id: string }>(
          `SELECT campaign_id FROM actors WHERE id = $1 AND deleted_at IS NULL`,
          [actorId],
        );
        const campaignId = owning.rows[0]?.campaign_id;
        if (!campaignId) throw new HttpError(404, 'not_found', 'Personaggio non trovato');
        requireGameMaster(await requireCampaignAccess(context, viewer, campaignId));
        const input = parseBody(updateActorInputSchema, request.body);

        const current = await context.pool.query<ActorRow>(`${SELECT_ACTORS} AND a.id = $1`, [
          actorId,
        ]);
        const before = current.rows[0];
        if (!before) throw new HttpError(404, 'not_found', 'Personaggio non trovato');
        const vision = { ...toActorVision(before), ...(input.vision ?? {}) };

        const { rows } = await context.pool.query<{ id: string }>(
          `UPDATE actors
              SET name                 = COALESCE($3, name),
                  size_in_cells        = COALESCE($4, size_in_cells),
                  color                = COALESCE($5, color),
                  darkvision_meters    = $6,
                  normal_vision_meters = $7,
                  special_senses       = $8::jsonb,
                  movement             = COALESCE($9::jsonb, movement),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING id`,
          [
            actorId,
            input.version,
            input.name ?? null,
            input.sizeInCells ?? null,
            input.color ?? null,
            vision.darkvisionMeters,
            vision.normalRangeMeters,
            JSON.stringify(vision.specialSenses),
            input.movement ? JSON.stringify(input.movement) : null,
          ],
        );
        if (rows.length === 0) {
          throw new HttpError(
            409,
            'version_conflict',
            'Il personaggio è stato modificato altrove',
            toActor(before),
          );
        }

        const updated = await context.pool.query<ActorRow>(`${SELECT_ACTORS} AND a.id = $1`, [
          actorId,
        ]);
        const row = updated.rows[0];
        if (!row) throw new Error('personaggio non leggibile dopo l aggiornamento');
        return { status: 200, body: toActor(row) };
      },
    },

    {
      method: 'PUT',
      pattern: '/api/actors/:actorId/owners',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const actorId = params.actorId ?? '';
        const owning = await context.pool.query<{ campaign_id: string }>(
          `SELECT campaign_id FROM actors WHERE id = $1 AND deleted_at IS NULL`,
          [actorId],
        );
        const campaignId = owning.rows[0]?.campaign_id;
        if (!campaignId) throw new HttpError(404, 'not_found', 'Personaggio non trovato');
        requireGameMaster(await requireCampaignAccess(context, viewer, campaignId));
        const input = parseBody(setActorOwnersInputSchema, request.body);

        // Si possono assegnare solo persone che sono davvero nella campagna.
        const valid = await context.pool.query<{ user_id: string }>(
          `SELECT user_id FROM campaign_memberships
            WHERE campaign_id = $1 AND status = 'active' AND user_id = ANY($2::uuid[])`,
          [campaignId, input.userIds],
        );
        const allowed = new Set(valid.rows.map((row) => row.user_id));
        const rejected = input.userIds.filter((id) => !allowed.has(id));
        if (rejected.length > 0) {
          throw new HttpError(
            400,
            'not_a_member',
            'Una delle persone indicate non fa parte della campagna',
          );
        }

        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM actor_ownership WHERE actor_id = $1', [actorId]);
          for (const userId of allowed) {
            await client.query(
              'INSERT INTO actor_ownership (actor_id, user_id) VALUES ($1, $2)',
              [actorId, userId],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }

        const { rows } = await context.pool.query<ActorRow>(`${SELECT_ACTORS} AND a.id = $1`, [
          actorId,
        ]);
        const row = rows[0];
        if (!row) throw new Error('attore non leggibile dopo l aggiornamento');
        return { status: 200, body: toActor(row) };
      },
    },
  ];
}

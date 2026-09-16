import {
  createActorInputSchema,
  setActorOwnersInputSchema,
  type Actor,
  type ActorKind,
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
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_ACTORS = `
  SELECT a.id, a.campaign_id, a.kind, a.name, a.size_in_cells, a.color,
         ARRAY(SELECT o.user_id FROM actor_ownership o WHERE o.actor_id = a.id) AS owner_user_ids,
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
          `INSERT INTO actors (campaign_id, kind, name, size_in_cells, color)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [access.campaignId, input.kind, input.name, input.sizeInCells, input.color],
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

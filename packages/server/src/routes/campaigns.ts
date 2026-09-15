import {
  createCampaignInputSchema,
  type Campaign,
  type CampaignRole,
} from '@legendforge/contracts';
import { DEFAULT_RULE_SET, mergeRuleSet } from '@legendforge/core';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';

interface CampaignRow {
  id: string;
  name: string;
  description: string;
  player_slots: number;
  owner_user_id: string;
  rule_set: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  viewer_role: CampaignRole;
  scene_count: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    playerSlots: row.player_slots,
    ownerUserId: row.owner_user_id,
    ruleSet: mergeRuleSet(row.rule_set as never),
    viewerRole: row.viewer_role,
    sceneCount: row.scene_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_CAMPAIGNS = `
  SELECT c.id, c.name, c.description, c.player_slots, c.owner_user_id, c.rule_set,
         c.created_at, c.updated_at, c.version,
         m.role AS viewer_role,
         (SELECT count(*)::int FROM scenes s
           WHERE s.campaign_id = c.id AND s.deleted_at IS NULL) AS scene_count
    FROM campaigns c
    JOIN campaign_memberships m
      ON m.campaign_id = c.id AND m.user_id = $1 AND m.status = 'active'
   WHERE c.deleted_at IS NULL`;

export function campaignRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns',
      async handle({ request }) {
        const viewer = await requireViewer(context, request);
        const { rows } = await context.pool.query<CampaignRow>(
          `${SELECT_CAMPAIGNS} ORDER BY c.created_at DESC`,
          [viewer.id],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toCampaign) };
      },
    },

    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { rows } = await context.pool.query<CampaignRow>(
          `${SELECT_CAMPAIGNS} AND c.id = $2`,
          [viewer.id, params.campaignId],
        );
        const row = rows[0];
        // Chi non è iscritto riceve "non trovata", non "non autorizzato": non
        // deve poter scoprire quali campagne esistono.
        if (!row) throw new HttpError(404, 'not_found', 'Campagna non trovata');
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: toCampaign(row) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns',
      async handle({ request }) {
        const viewer = await requireViewer(context, request);
        const input = parseBody(createCampaignInputSchema, request.body);

        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO campaigns (owner_user_id, name, description, player_slots, rule_set)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [viewer.id, input.name, input.description, input.playerSlots, DEFAULT_RULE_SET],
          );
          const campaignId = inserted.rows[0]?.id;
          if (!campaignId) throw new Error('creazione campagna fallita');

          // Chi crea la campagna ne diventa Game Master.
          await client.query(
            `INSERT INTO campaign_memberships (campaign_id, user_id, role)
             VALUES ($1, $2, 'game_master')`,
            [campaignId, viewer.id],
          );
          await client.query('COMMIT');

          const { rows } = await context.pool.query<CampaignRow>(
            `${SELECT_CAMPAIGNS} AND c.id = $2`,
            [viewer.id, campaignId],
          );
          const row = rows[0];
          if (!row) throw new Error('campagna non leggibile dopo la creazione');
          return { status: 201, body: toCampaign(row) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },
  ];
}

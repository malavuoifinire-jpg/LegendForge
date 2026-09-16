import {
  createCampaignInputSchema,
  joinCampaignInputSchema,
  type Campaign,
  type CampaignRole,
} from '@legendforge/contracts';
import { DEFAULT_RULE_SET, mergeRuleSet } from '@legendforge/core';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';
import { canonicalJoinCode, generateJoinCode } from '../identity/secrets.js';
import { clientKey, consumeRateLimit } from '../rate-limit.js';
import { requireCampaignAccess, requireGameMaster } from '../access.js';

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
  join_code: string | null;
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
    // Il codice è un dato del Game Master: agli altri non serve e non spetta.
    joinCode: row.viewer_role === 'game_master' ? row.join_code : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_CAMPAIGNS = `
  SELECT c.id, c.name, c.description, c.player_slots, c.owner_user_id, c.rule_set,
         c.created_at, c.updated_at, c.version, c.join_code,
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
            `INSERT INTO campaigns (owner_user_id, name, description, player_slots, rule_set, join_code)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              viewer.id,
              input.name,
              input.description,
              input.playerSlots,
              DEFAULT_RULE_SET,
              generateJoinCode(),
            ],
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
    {
      /**
       * Ingresso con il codice della campagna.
       *
       * Un codice di otto caratteri è comodo da dettare ma non è un segreto
       * forte: i tentativi sono limitati per account e per provenienza, e il
       * Game Master può rigenerarlo in qualsiasi momento.
       */
      method: 'POST',
      pattern: '/api/campaigns/join',
      async handle({ request }) {
        const viewer = await requireViewer(context, request);
        const input = parseBody(joinCampaignInputSchema, request.body);
        const code = canonicalJoinCode(input.code);

        for (const [bucket, key] of [
          ['join-code-user', viewer.id],
          ['join-code-origin', clientKey(request.headers)],
        ] as const) {
          const limit = await consumeRateLimit(context.pool, bucket, key, 10, 3600);
          if (!limit.allowed) {
            throw new HttpError(
              429,
              'too_many_attempts',
              `Troppi tentativi. Riprova fra ${Math.ceil(limit.retryAfterSeconds / 60)} minuti.`,
            );
          }
        }

        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          const found = await client.query<{ id: string; player_slots: number; joined: number }>(
            `SELECT c.id, c.player_slots,
                    (SELECT count(*)::int FROM campaign_memberships m
                      WHERE m.campaign_id = c.id AND m.role = 'player' AND m.status = 'active')
                      AS joined
               FROM campaigns c
              WHERE c.join_code = $1 AND c.deleted_at IS NULL
              FOR UPDATE`,
            [code],
          );
          const campaign = found.rows[0];
          if (!campaign) {
            await client.query('ROLLBACK');
            throw new HttpError(404, 'invalid_code', 'Codice non valido');
          }

          const existing = await client.query(
            'SELECT 1 FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
            [campaign.id, viewer.id],
          );
          if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            // Già dentro: non è un errore, è il risultato desiderato.
            const { rows } = await context.pool.query<CampaignRow>(
              `${SELECT_CAMPAIGNS} AND c.id = $2`,
              [viewer.id, campaign.id],
            );
            const row = rows[0];
            if (!row) throw new HttpError(404, 'invalid_code', 'Codice non valido');
            return { status: 200, body: toCampaign(row) };
          }

          if (campaign.joined >= campaign.player_slots) {
            await client.query('ROLLBACK');
            throw new HttpError(409, 'campaign_full', 'La campagna ha esaurito i posti');
          }

          await client.query(
            `INSERT INTO campaign_memberships (campaign_id, user_id, role)
             VALUES ($1, $2, 'player')`,
            [campaign.id, viewer.id],
          );
          await client.query('COMMIT');

          const { rows } = await context.pool.query<CampaignRow>(
            `${SELECT_CAMPAIGNS} AND c.id = $2`,
            [viewer.id, campaign.id],
          );
          const row = rows[0];
          if (!row) throw new Error('campagna non leggibile dopo l ingresso');
          return { status: 201, body: toCampaign(row) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/join-code',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const { rows } = await context.pool.query<{ join_code: string }>(
          `UPDATE campaigns
              SET join_code = $2, updated_at = now(), version = version + 1
            WHERE id = $1 RETURNING join_code`,
          [access.campaignId, generateJoinCode()],
        );
        return {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
          body: { joinCode: rows[0]?.join_code ?? null },
        };
      },
    },
  ];
}

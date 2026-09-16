import {
  acceptInviteInputSchema,
  createInviteInputSchema,
  type CampaignMember,
  type CreatedInvite,
  type Invite,
  type InvitePreview,
} from '@legendforge/contracts';
import { requireCampaignAccess, requireGameMaster } from '../access.js';
import { requireViewer, resolveViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { serializeSessionCookie } from '../identity/cookies.js';
import {
  acceptInvite,
  createInvite,
  findInviteByToken,
  inviteStatus,
  seatUsage,
  type InviteRow,
} from '../identity/invites.js';
import { createSession, SESSION_DURATION_SECONDS } from '../identity/store.js';
import { parseBody } from '../validate.js';

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    label: row.label,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
    status: inviteStatus(row),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_INVITES = `
  SELECT id, campaign_id, label, max_uses, used_count, expires_at, revoked_at,
         created_at, updated_at, version
    FROM invites`;

export function inviteRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/invites',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const { rows } = await context.pool.query<InviteRow>(
          `${SELECT_INVITES} WHERE campaign_id = $1 ORDER BY created_at DESC`,
          [access.campaignId],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toInvite) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/invites',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createInviteInputSchema, request.body);
        const { row, token } = await createInvite(context.pool, access.campaignId, viewer.id, {
          label: input.label,
          maxUses: input.maxUses,
          expiresInHours: input.expiresInHours,
        });
        // Il token viene restituito adesso e mai più: nel database c'è solo
        // la sua impronta.
        const body: CreatedInvite = {
          ...toInvite(row),
          token,
          joinPath: `/entra/${token}`,
        };
        return { status: 201, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/invites/:inviteId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { rows } = await context.pool.query<{ campaign_id: string }>(
          `SELECT campaign_id FROM invites WHERE id = $1`,
          [params.inviteId],
        );
        const campaignId = rows[0]?.campaign_id;
        if (!campaignId) throw new HttpError(404, 'not_found', 'Invito non trovato');
        requireGameMaster(await requireCampaignAccess(context, viewer, campaignId));

        await context.pool.query(
          `UPDATE invites SET revoked_at = now(), updated_at = now(), version = version + 1
            WHERE id = $1 AND revoked_at IS NULL`,
          [params.inviteId],
        );
        return { status: 200, body: { ok: true } };
      },
    },

    {
      // Aperta di proposito: chi ha il link deve poter vedere dove sta entrando
      // prima di scegliere nome e PIN. Espone solo il nome della campagna e i
      // posti rimasti, mai i partecipanti.
      method: 'GET',
      pattern: '/api/invites/:token/preview',
      async handle({ params }) {
        const token = params.token ?? '';
        const invite = await findInviteByToken(context.pool, token);
        const notFound: InvitePreview = {
          valid: false,
          reason: 'not_found',
          campaignName: null,
          seatsLeft: null,
        };
        if (!invite) return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: notFound };

        const status = inviteStatus(invite);
        const seats = await seatUsage(context.pool, invite.campaign_id);
        if (!seats) return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: notFound };
        const seatsLeft = Math.max(0, seats.playerSlots - seats.playersJoined);

        const body: InvitePreview =
          status !== 'active'
            ? { valid: false, reason: status === 'revoked' ? 'revoked' : status === 'expired' ? 'expired' : 'exhausted', campaignName: seats.campaignName, seatsLeft }
            : seatsLeft === 0
              ? { valid: false, reason: 'full', campaignName: seats.campaignName, seatsLeft }
              : { valid: true, reason: 'ok', campaignName: seats.campaignName, seatsLeft };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'POST',
      pattern: '/api/invites/:token/accept',
      async handle({ request, params }) {
        const input = parseBody(acceptInviteInputSchema, request.body);
        const outcome = await acceptInvite(
          context.pool,
          params.token ?? '',
          input.displayName,
          input.pin,
        );

        if (!outcome.ok) {
          if (outcome.reason === 'name_taken') {
            throw new HttpError(
              409,
              'name_taken',
              'Questo nome è già in uso: scegline un altro',
            );
          }
          if (outcome.reason === 'full') {
            throw new HttpError(409, 'campaign_full', 'La campagna ha esaurito i posti');
          }
          throw new HttpError(404, 'invalid_invite', 'Invito non valido, scaduto o revocato');
        }

        const token = await createSession(context.pool, outcome.userId, request.headers['user-agent']);
        const viewer = await resolveViewer(context, {
          ...request,
          headers: { ...request.headers, cookie: `lf_session=${token}` },
        });
        return {
          status: 201,
          headers: {
            'Set-Cookie': serializeSessionCookie(token, {
              maxAgeSeconds: SESSION_DURATION_SECONDS,
              secure: context.env.nodeEnv === 'production',
            }),
            'Cache-Control': 'no-store',
          },
          body: { viewer },
        };
      },
    },

    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/members',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const { rows } = await context.pool.query<{
          user_id: string;
          display_name: string;
          role: CampaignMember['role'];
          status: CampaignMember['status'];
          joined_at: Date | string;
          actor_ids: string[] | null;
        }>(
          `SELECT m.user_id, u.display_name, m.role, m.status, m.joined_at,
                  ARRAY(
                    SELECT o.actor_id FROM actor_ownership o
                      JOIN actors a ON a.id = o.actor_id
                     WHERE o.user_id = m.user_id AND a.campaign_id = m.campaign_id
                  ) AS actor_ids
             FROM campaign_memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.campaign_id = $1
            ORDER BY m.role DESC, m.joined_at ASC`,
          [access.campaignId],
        );
        const members: CampaignMember[] = rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          role: row.role,
          status: row.status,
          joinedAt: toIso(row.joined_at),
          actorIds: row.actor_ids ?? [],
        }));
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: members };
      },
    },
  ];
}

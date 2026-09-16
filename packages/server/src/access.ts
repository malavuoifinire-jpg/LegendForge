import type { CampaignRole, Viewer } from '@legendforge/contracts';
import type { ServerContext } from './context.js';
import { HttpError } from './http.js';

/**
 * Verifiche di appartenenza e ruolo.
 *
 * Regola costante: a chi non è membro la risorsa risulta **inesistente**, non
 * vietata. Un 403 confermerebbe che quella campagna o quella scena esistono.
 */

export interface CampaignAccess {
  campaignId: string;
  role: CampaignRole;
}

export async function requireCampaignAccess(
  context: ServerContext,
  viewer: Viewer,
  campaignId: string,
): Promise<CampaignAccess> {
  const { rows } = await context.pool.query<{ role: CampaignRole }>(
    `SELECT m.role
       FROM campaign_memberships m
       JOIN campaigns c ON c.id = m.campaign_id AND c.deleted_at IS NULL
      WHERE m.campaign_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [campaignId, viewer.id],
  );
  const role = rows[0]?.role;
  if (!role) throw new HttpError(404, 'not_found', 'Campagna non trovata');
  return { campaignId, role };
}

export function requireGameMaster(access: CampaignAccess): CampaignAccess {
  if (access.role !== 'game_master') {
    throw new HttpError(403, 'forbidden', 'Solo il Game Master può eseguire questa operazione');
  }
  return access;
}

export interface SceneAccess extends CampaignAccess {
  sceneId: string;
}

export async function requireSceneAccess(
  context: ServerContext,
  viewer: Viewer,
  sceneId: string,
): Promise<SceneAccess> {
  const { rows } = await context.pool.query<{ campaign_id: string; role: CampaignRole }>(
    `SELECT s.campaign_id, m.role
       FROM scenes s
       JOIN campaigns c ON c.id = s.campaign_id AND c.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sceneId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Scena non trovata');
  return { sceneId, campaignId: row.campaign_id, role: row.role };
}

export interface TokenAccess extends SceneAccess {
  tokenId: string;
}

export async function requireTokenAccess(
  context: ServerContext,
  viewer: Viewer,
  tokenId: string,
): Promise<TokenAccess> {
  const { rows } = await context.pool.query<{
    scene_id: string;
    campaign_id: string;
    role: CampaignRole;
  }>(
    `SELECT t.scene_id, s.campaign_id, m.role
       FROM tokens t
       JOIN scenes s ON s.id = t.scene_id AND s.deleted_at IS NULL
       JOIN campaigns c ON c.id = s.campaign_id AND c.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE t.id = $1`,
    [tokenId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Pedina non trovata');
  return { tokenId, sceneId: row.scene_id, campaignId: row.campaign_id, role: row.role };
}

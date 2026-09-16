import {
  createTokenInputSchema,
  updateTokenInputSchema,
  type Token,
  type TokenDisposition,
} from '@legendforge/contracts';
import { snapImagePointToFootprint, type GridConfiguration } from '@legendforge/core';
import { requireGameMaster, requireSceneAccess, requireTokenAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { emitSceneEvent, pruneSceneEvents } from '../events.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';

/**
 * Quanto controllo ha chi guarda su una pedina.
 *
 *  - `full` : il Game Master, che può tutto.
 *  - `move` : chi possiede il personaggio rappresentato. Può spostarlo e
 *             ruotarlo, non rinominarlo, ridimensionarlo o nasconderlo.
 *  - `none` : chiunque altro.
 */
export type ControlLevel = 'full' | 'move' | 'none';

export async function controlLevel(
  context: ServerContext,
  userId: string,
  role: string,
  actorId: string | null,
): Promise<ControlLevel> {
  if (role === 'game_master') return 'full';
  if (!actorId) return 'none';
  const { rows } = await context.pool.query(
    'SELECT 1 FROM actor_ownership WHERE actor_id = $1 AND user_id = $2',
    [actorId, userId],
  );
  return rows.length > 0 ? 'move' : 'none';
}

/** Campi che chi ha solo il controllo del movimento può toccare. */
const MOVEMENT_FIELDS = new Set(['version', 'x', 'y', 'rotationDeg', 'snapToGrid']);

/**
 * Notifica la modifica di una pedina.
 *
 * Una pedina nascosta produce due eventi diversi: ai giocatori si dice che è
 * sparita, al Game Master si manda lo stato vero. Al contrario, quando torna
 * visibile, i giocatori ricevono la pedina intera — è il momento in cui hanno
 * diritto di conoscerla.
 */
async function announceToken(context: ServerContext, sceneId: string, token: Token): Promise<void> {
  if (token.hidden) {
    await emitSceneEvent(context.pool, sceneId, 'token.removed', { id: token.id }, 'all');
    await emitSceneEvent(context.pool, sceneId, 'token.upserted', token, 'game_master');
  } else {
    await emitSceneEvent(context.pool, sceneId, 'token.upserted', token, 'all');
  }
  void pruneSceneEvents(context.pool, sceneId);
}

export interface TokenRow {
  id: string;
  scene_id: string;
  actor_id: string | null;
  name: string;
  x: number;
  y: number;
  size_in_cells: number;
  rotation_deg: number;
  color: string;
  disposition: TokenDisposition;
  hidden: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toToken(row: TokenRow): Token {
  return {
    id: row.id,
    sceneId: row.scene_id,
    actorId: row.actor_id,
    name: row.name,
    x: row.x,
    y: row.y,
    sizeInCells: row.size_in_cells,
    rotationDeg: row.rotation_deg,
    color: row.color,
    disposition: row.disposition,
    hidden: row.hidden,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_TOKEN = `
  SELECT id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
         color, disposition, hidden, created_at, updated_at, version
    FROM tokens`;

async function gridOf(context: ServerContext, sceneId: string): Promise<GridConfiguration> {
  const { rows } = await context.pool.query<{
    cell_size_px: number;
    offset_x: number;
    offset_y: number;
    rotation_deg: number;
    meters_per_cell: number;
    snap_enabled: boolean;
  }>(
    `SELECT cell_size_px, offset_x, offset_y, rotation_deg, meters_per_cell, snap_enabled
       FROM grid_configurations WHERE scene_id = $1`,
    [sceneId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Griglia della scena non trovata');
  return {
    cellSizePx: row.cell_size_px,
    offsetX: row.offset_x,
    offsetY: row.offset_y,
    rotationDeg: row.rotation_deg,
    metersPerCell: row.meters_per_cell,
    snapEnabled: row.snap_enabled,
  };
}

/**
 * L'aggancio lo calcola il server.
 *
 * Se lo facesse solo il client, due client con impostazioni diverse
 * salverebbero posizioni diverse per lo stesso gesto, e il server sarebbe
 * autorità solo a parole.
 */
function place(
  point: { x: number; y: number },
  grid: GridConfiguration,
  sizeInCells: number,
  snapRequested: boolean,
): { x: number; y: number } {
  if (!snapRequested || !grid.snapEnabled) return point;
  return snapImagePointToFootprint(point, grid, sizeInCells);
}

export function tokenRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'POST',
      pattern: '/api/scenes/:sceneId/tokens',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(createTokenInputSchema, request.body);

        const actorId: string | null = input.actorId ?? null;
        let sizeInCells = input.sizeInCells;
        let color = input.color;
        if (actorId) {
          const actors = await context.pool.query<{
            size_in_cells: number;
            color: string;
            name: string;
          }>(
            `SELECT size_in_cells, color, name FROM actors
              WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`,
            [actorId, access.campaignId],
          );
          const actor = actors.rows[0];
          if (!actor) throw new HttpError(404, 'not_found', 'Personaggio non trovato');
          // La pedina eredita dal personaggio ciò che non è stato indicato.
          sizeInCells = input.sizeInCells === 1 ? actor.size_in_cells : input.sizeInCells;
          color = input.color === '#60a5fa' ? actor.color : input.color;
        }

        const grid = await gridOf(context, access.sceneId);
        const position = place({ x: input.x, y: input.y }, grid, sizeInCells, input.snapToGrid);

        const { rows } = await context.pool.query<TokenRow>(
          `INSERT INTO tokens (scene_id, actor_id, name, x, y, size_in_cells, color, disposition, hidden)
           VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
                     color, disposition, hidden, created_at, updated_at, version`,
          [
            access.sceneId,
            input.name,
            position.x,
            position.y,
            sizeInCells,
            color,
            input.disposition,
            input.hidden,
            actorId,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('creazione pedina fallita');
        const token = toToken(row);
        await announceToken(context, access.sceneId, token);
        return { status: 201, body: token };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/tokens/:tokenId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireTokenAccess(context, viewer, params.tokenId ?? '');
        const input = parseBody(updateTokenInputSchema, request.body);

        const currentRows = await context.pool.query<TokenRow>(`${SELECT_TOKEN} WHERE id = $1`, [
          access.tokenId,
        ]);
        const current = currentRows.rows[0];
        if (!current) throw new HttpError(404, 'not_found', 'Pedina non trovata');

        const control = await controlLevel(context, viewer.id, access.role, current.actor_id);
        if (control === 'none') {
          throw new HttpError(403, 'forbidden', 'Questa pedina non è sotto il tuo controllo');
        }
        if (control === 'move') {
          const forbidden = Object.keys(request.body as Record<string, unknown>).filter(
            (key) => !MOVEMENT_FIELDS.has(key),
          );
          if (forbidden.length > 0) {
            throw new HttpError(
              403,
              'forbidden',
              'Puoi spostare la pedina, non modificarne le proprietà',
            );
          }
        }

        const grid = await gridOf(context, access.sceneId);
        const sizeInCells = input.sizeInCells ?? current.size_in_cells;
        const moved = input.x !== undefined || input.y !== undefined;
        const target = { x: input.x ?? current.x, y: input.y ?? current.y };
        const position = moved
          ? place(target, grid, sizeInCells, input.snapToGrid ?? true)
          : target;

        const { rows } = await context.pool.query<TokenRow>(
          `UPDATE tokens
              SET name          = COALESCE($3, name),
                  x             = $4,
                  y             = $5,
                  size_in_cells = COALESCE($6, size_in_cells),
                  rotation_deg  = COALESCE($7, rotation_deg),
                  color         = COALESCE($8, color),
                  disposition   = COALESCE($9, disposition),
                  hidden        = COALESCE($10, hidden),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
                  color, disposition, hidden, created_at, updated_at, version`,
          [
            access.tokenId,
            input.version,
            input.name ?? null,
            position.x,
            position.y,
            input.sizeInCells ?? null,
            input.rotationDeg ?? null,
            input.color ?? null,
            input.disposition ?? null,
            input.hidden ?? null,
          ],
        );

        const row = rows[0];
        if (!row) {
          // Zero righe aggiornate significa conflitto, non assenza: la pedina
          // esiste — l'abbiamo appena letta — ma qualcuno l'ha già modificata.
          throw new HttpError(
            409,
            'version_conflict',
            'La pedina è stata modificata altrove',
            toToken(current),
          );
        }
        const token = toToken(row);
        // Se la pedina era nascosta e non lo è più, i giocatori devono
        // scoprirla adesso; se è appena stata nascosta, deve sparire.
        await announceToken(context, access.sceneId, token);
        return { status: 200, body: token };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/tokens/:tokenId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireTokenAccess(context, viewer, params.tokenId ?? '');
        requireGameMaster(access);
        await context.pool.query('DELETE FROM tokens WHERE id = $1', [access.tokenId]);
        await emitSceneEvent(
          context.pool,
          access.sceneId,
          'token.removed',
          { id: access.tokenId },
          'all',
        );
        return { status: 200, body: { ok: true } };
      },
    },
  ];
}

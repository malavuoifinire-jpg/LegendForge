import {
  createTokenInputSchema,
  updateTokenInputSchema,
  type Token,
  type TokenDisposition,
} from '@legendforge/contracts';
import { snapImagePointToFootprint, type GridConfiguration } from '@legendforge/core';
import { requireGameMaster, requireSceneAccess, requireTokenAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';

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

        const grid = await gridOf(context, access.sceneId);
        const position = place(
          { x: input.x, y: input.y },
          grid,
          input.sizeInCells,
          input.snapToGrid,
        );

        const { rows } = await context.pool.query<TokenRow>(
          `INSERT INTO tokens (scene_id, name, x, y, size_in_cells, color, disposition, hidden)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
                     color, disposition, hidden, created_at, updated_at, version`,
          [
            access.sceneId,
            input.name,
            position.x,
            position.y,
            input.sizeInCells,
            input.color,
            input.disposition,
            input.hidden,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('creazione pedina fallita');
        return { status: 201, body: toToken(row) };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/tokens/:tokenId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireTokenAccess(context, viewer, params.tokenId ?? '');
        const input = parseBody(updateTokenInputSchema, request.body);

        // Nella milestone 1 l'unico partecipante è il Game Master; la proprietà
        // per personaggio assegnato arriva con gli inviti, alla milestone 2.
        requireGameMaster(access);

        const currentRows = await context.pool.query<TokenRow>(`${SELECT_TOKEN} WHERE id = $1`, [
          access.tokenId,
        ]);
        const current = currentRows.rows[0];
        if (!current) throw new HttpError(404, 'not_found', 'Pedina non trovata');

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
        return { status: 200, body: toToken(row) };
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
        return { status: 200, body: { ok: true } };
      },
    },
  ];
}

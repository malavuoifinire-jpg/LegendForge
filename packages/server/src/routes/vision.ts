import {
  createLightInputSchema,
  createWallsInputSchema,
  doorStateSchema,
  updateLightInputSchema,
  updateSceneVisionInputSchema,
  updateWallInputSchema,
  type CampaignRole,
  type LightSource,
  type SceneVisionSettings,
  type SceneVisionState,
  type Token,
  type Viewpoint,
  type Wall,
} from '@legendforge/contracts';
import { distanceToSegment, metersToPixels, type GridConfiguration } from '@legendforge/core';
import { z } from 'zod';
import { requireGameMaster, requireSceneAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { emitSceneEvent, pruneSceneEvents } from '../events.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';
import { forgetExploration, rememberAndLoad } from '../exploration.js';
import { controlLevel, toToken, type TokenRow } from './tokens.js';
import {
  computeViewpoints,
  loadLights,
  loadVisionProfiles,
  loadWalls,
  doorsInSight,
  toLight,
  tokenIsVisible,
  toWall,
  type LightRow,
  type WallRow,
} from '../vision.js';

/**
 * Muri, luci e campo visivo.
 *
 * Le rotte di scrittura sono del Game Master. Quella di lettura è di tutti, ma
 * restituisce cose diverse: al Game Master i muri e le luci, al giocatore solo
 * il poligono di ciò che le sue pedine vedono. Da un poligono non si ricava la
 * pianta di una stanza mai vista.
 */

interface SceneVisionRow {
  vision_enabled: boolean;
  fog_enabled: boolean;
  ambient_darkness: number;
  scene_reach_meters: number;
  version: number;
  map_asset_id: string | null;
  map_width_px: number | null;
  map_height_px: number | null;
  cell_size_px: number;
  offset_x: number;
  offset_y: number;
  rotation_deg: number;
  meters_per_cell: number;
  snap_enabled: boolean;
}

export interface SceneVisionContext {
  settings: SceneVisionSettings;
  sceneVersion: number;
  grid: GridConfiguration;
  mapAssetId: string | null;
  /** Dimensioni native della mappa, quando ce n'è una. */
  map: { widthPx: number; heightPx: number } | null;
}

export async function loadSceneVisionContext(
  context: ServerContext,
  sceneId: string,
): Promise<SceneVisionContext> {
  const { rows } = await context.pool.query<SceneVisionRow>(
    `SELECT s.vision_enabled, s.fog_enabled, s.ambient_darkness, s.scene_reach_meters, s.version,
            s.map_asset_id, m.width_px AS map_width_px, m.height_px AS map_height_px,
            g.cell_size_px, g.offset_x, g.offset_y, g.rotation_deg, g.meters_per_cell, g.snap_enabled
       FROM scenes s
       JOIN grid_configurations g ON g.scene_id = s.id
       LEFT JOIN map_assets m ON m.id = s.map_asset_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sceneId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Scena non trovata');
  return {
    settings: {
      visionEnabled: row.vision_enabled,
      fogEnabled: row.fog_enabled,
      ambientDarkness: Number(row.ambient_darkness),
      sceneReachMeters: Number(row.scene_reach_meters),
    },
    sceneVersion: row.version,
    grid: {
      cellSizePx: Number(row.cell_size_px),
      offsetX: Number(row.offset_x),
      offsetY: Number(row.offset_y),
      rotationDeg: Number(row.rotation_deg),
      metersPerCell: Number(row.meters_per_cell),
      snapEnabled: row.snap_enabled,
    },
    mapAssetId: row.map_asset_id,
    map:
      row.map_width_px !== null && row.map_height_px !== null
        ? { widthPx: Number(row.map_width_px), heightPx: Number(row.map_height_px) }
        : null,
  };
}

/** Tutte le pedine della scena, senza filtri: il filtro lo applica chi chiama. */
export async function loadAllTokens(context: ServerContext, sceneId: string): Promise<Token[]> {
  const { rows } = await context.pool.query<TokenRow>(
    `SELECT id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
            color, disposition, hidden, created_at, updated_at, version
       FROM tokens WHERE scene_id = $1 ORDER BY created_at ASC`,
    [sceneId],
  );
  return rows.map(toToken);
}

/** Le pedine che questa persona muove: sono i suoi occhi sulla scena. */
export async function controlledTokens(
  context: ServerContext,
  userId: string,
  role: CampaignRole,
  tokens: readonly Token[],
): Promise<Token[]> {
  const mine: Token[] = [];
  for (const token of tokens) {
    const level = await controlLevel(context, userId, role, token.actorId);
    if (level !== 'none') mine.push(token);
  }
  return mine;
}

/**
 * I punti di vista di chi guarda.
 *
 * Il Game Master vede tutto e non ha bisogno di poligoni. Un giocatore guarda
 * attraverso le sue pedine: se non ne controlla nessuna in questa scena, non ha
 * occhi qui, e la lista vuota lo dice senza inventare eccezioni.
 */
export async function viewerViewpoints(
  context: ServerContext,
  sceneId: string,
  userId: string,
  role: CampaignRole,
  options: { throughTokenIds?: string[] } = {},
): Promise<{
  viewpoints: Viewpoint[];
  tokens: Token[];
  vision: SceneVisionContext;
  visibleDoors: Wall[];
}> {
  const vision = await loadSceneVisionContext(context, sceneId);
  const tokens = await loadAllTokens(context, sceneId);

  let eyes: Token[];
  if (options.throughTokenIds) {
    const wanted = new Set(options.throughTokenIds);
    eyes = tokens.filter((token) => wanted.has(token.id));
  } else if (role === 'game_master') {
    eyes = [];
  } else {
    eyes = await controlledTokens(context, userId, role, tokens);
  }
  if (eyes.length === 0) return { viewpoints: [], tokens, vision, visibleDoors: [] };

  const [walls, lights, profiles] = await Promise.all([
    loadWalls(context, sceneId),
    loadLights(context, sceneId),
    loadVisionProfiles(context, sceneId),
  ]);

  const viewpoints = computeViewpoints(
    { settings: vision.settings, grid: vision.grid, walls, lights, tokens, profiles },
    eyes,
  );
  return { viewpoints, tokens, vision, visibleDoors: doorsInSight(viewpoints, walls) };
}

/**
 * Le pedine che questa persona ha diritto di vedere, e i suoi punti di vista.
 *
 * È l'unico punto in cui si decide: lo usano sia la lettura completa della
 * scena sia il calcolo del campo visivo, quindi non possono divergere. Una
 * pedina fuori dal campo visivo non viene marcata come invisibile, non viene
 * proprio spedita.
 */
export async function visibleTokensForViewer(
  context: ServerContext,
  sceneId: string,
  userId: string,
  role: CampaignRole,
): Promise<{ tokens: Token[]; viewpoints: Viewpoint[]; vision: SceneVisionContext }> {
  const vision = await loadSceneVisionContext(context, sceneId);
  const all = await loadAllTokens(context, sceneId);

  if (role === 'game_master') return { tokens: all, viewpoints: [], vision };

  const visible = all.filter((token) => !token.hidden);
  if (!vision.settings.visionEnabled) return { tokens: visible, viewpoints: [], vision };

  const mine = await controlledTokens(context, userId, role, all);
  const mineIds = new Set(mine.map((token) => token.id));
  if (mine.length === 0) {
    // Nessuna pedina, nessun occhio: la scena resta al buio finché il Game
    // Master non assegna un personaggio.
    return { tokens: [], viewpoints: [], vision };
  }

  const [walls, lights, profiles] = await Promise.all([
    loadWalls(context, sceneId),
    loadLights(context, sceneId),
    loadVisionProfiles(context, sceneId),
  ]);
  const viewpoints = computeViewpoints(
    { settings: vision.settings, grid: vision.grid, walls, lights, tokens: all, profiles },
    mine,
  );

  const tokens = visible.filter(
    (token) => mineIds.has(token.id) || tokenIsVisible(viewpoints, token, vision.grid),
  );
  return { tokens, viewpoints, vision };
}

const previewQuerySchema = z.object({
  /** Anteprima dal punto di vista di una pedina: solo per il Game Master. */
  asToken: z.string().uuid().optional(),
});

async function requireWallOwner(
  context: ServerContext,
  viewer: { id: string },
  wallId: string,
): Promise<{ wall: Wall; sceneId: string; role: CampaignRole }> {
  const { rows } = await context.pool.query<WallRow & { role: CampaignRole }>(
    `SELECT w.id, w.scene_id, w.ax, w.ay, w.bx, w.by, w.kind, w.door_state,
            w.created_at, w.updated_at, w.version, m.role
       FROM scene_walls w
       JOIN scenes s ON s.id = w.scene_id AND s.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE w.id = $1`,
    [wallId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Muro non trovato');
  return { wall: toWall(row), sceneId: row.scene_id, role: row.role };
}

async function announceVision(context: ServerContext, sceneId: string, kind: 'wall.changed' | 'light.changed' | 'vision.changed'): Promise<void> {
  // L'evento dice soltanto che qualcosa è cambiato: ogni client rilegge il
  // proprio stato passando dalla propria autorizzazione. Nessun dato di muro
  // viaggia in un messaggio destinato a tutti.
  await emitSceneEvent(context.pool, sceneId, kind, { sceneId }, 'all');
  void pruneSceneEvents(context.pool, sceneId);
}

/** Quanto lontano si può allungare una mano per aprire una porta. */
const DOOR_REACH_METERS = 3;

export function visionRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId/vision',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        const query = previewQuerySchema.safeParse(request.query);
        const asToken = query.success ? query.data.asToken : undefined;
        if (asToken && access.role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master può usare l anteprima');
        }

        const isGameMaster = access.role === 'game_master' && !asToken;
        const { viewpoints, vision, visibleDoors } = await viewerViewpoints(
          context,
          access.sceneId,
          viewer.id,
          access.role,
          asToken ? { throughTokenIds: [asToken] } : {},
        );

        // La memoria dell'esplorato è di chi gioca. Il Game Master vede tutto
        // comunque, e l'anteprima non deve sporcare il ricordo di nessuno.
        const remembered =
          access.role === 'game_master' ||
          !vision.settings.visionEnabled ||
          !vision.settings.fogEnabled
            ? null
            : await rememberAndLoad(
                context,
                access.sceneId,
                viewer.id,
                viewpoints,
                vision.grid,
                vision.map,
                vision.mapAssetId,
              );

        const body: SceneVisionState = {
          ...vision.settings,
          perspective: isGameMaster ? 'game_master' : 'tokens',
          viewpoints,
          walls: isGameMaster ? await loadWalls(context, access.sceneId) : null,
          lights: isGameMaster ? await loadLights(context, access.sceneId) : null,
          visibleDoors,
          exploration: remembered
            ? {
                originCol: remembered.originCol,
                originRow: remembered.originRow,
                widthCells: remembered.widthCells,
                heightCells: remembered.heightCells,
                cells: Buffer.from(remembered.bits).toString('base64'),
              }
            : null,
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/scenes/:sceneId/vision',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(updateSceneVisionInputSchema, request.body);

        const { rows } = await context.pool.query<{ version: number }>(
          `UPDATE scenes
              SET vision_enabled     = COALESCE($3, vision_enabled),
                  fog_enabled        = COALESCE($4, fog_enabled),
                  ambient_darkness   = COALESCE($5, ambient_darkness),
                  scene_reach_meters = COALESCE($6, scene_reach_meters),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING version`,
          [
            access.sceneId,
            input.version,
            input.visionEnabled ?? null,
            input.fogEnabled ?? null,
            input.ambientDarkness ?? null,
            input.sceneReachMeters ?? null,
          ],
        );
        if (rows.length === 0) {
          const current = await loadSceneVisionContext(context, access.sceneId);
          throw new HttpError(
            409,
            'version_conflict',
            'La scena è stata modificata altrove',
            current.settings,
          );
        }

        await announceVision(context, access.sceneId, 'vision.changed');
        const updated = await loadSceneVisionContext(context, access.sceneId);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: updated.settings };
      },
    },

    {
      /**
       * Dimentica l'esplorato.
       *
       * Serve quando la mappa cambia sotto le stesse coordinate, o quando si
       * ricomincia una sessione da capo. È del Game Master perché riguarda
       * tutti, non solo chi chiede.
       */
      method: 'DELETE',
      pattern: '/api/scenes/:sceneId/exploration',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        await forgetExploration(context, access.sceneId);
        await announceVision(context, access.sceneId, 'vision.changed');
        return { status: 200, body: { ok: true } };
      },
    },

    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId/walls',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const walls = await loadWalls(context, access.sceneId);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: walls };
      },
    },

    {
      method: 'POST',
      pattern: '/api/scenes/:sceneId/walls',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(createWallsInputSchema, request.body);

        const usable = input.walls.filter((wall) => wall.ax !== wall.bx || wall.ay !== wall.by);
        if (usable.length === 0) {
          throw new HttpError(422, 'invalid_input', 'Un muro lungo zero non ferma niente');
        }

        const values: unknown[] = [access.sceneId];
        const tuples = usable.map((wall) => {
          const base = values.length;
          values.push(wall.ax, wall.ay, wall.bx, wall.by, wall.kind, wall.doorState);
          return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        const { rows } = await context.pool.query<WallRow>(
          `INSERT INTO scene_walls (scene_id, ax, ay, bx, by, kind, door_state)
           VALUES ${tuples.join(', ')}
           RETURNING id, scene_id, ax, ay, bx, by, kind, door_state, created_at, updated_at, version`,
          values,
        );
        await announceVision(context, access.sceneId, 'wall.changed');
        return { status: 201, body: rows.map(toWall) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/scenes/:sceneId/walls',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        await context.pool.query('DELETE FROM scene_walls WHERE scene_id = $1', [access.sceneId]);
        await announceVision(context, access.sceneId, 'wall.changed');
        return { status: 200, body: { ok: true } };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/walls/:wallId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { wall, sceneId, role } = await requireWallOwner(context, viewer, params.wallId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master può modificare i muri');
        }
        const input = parseBody(updateWallInputSchema, request.body);

        const ax = input.ax ?? wall.ax;
        const ay = input.ay ?? wall.ay;
        const bx = input.bx ?? wall.bx;
        const by = input.by ?? wall.by;
        if (ax === bx && ay === by) {
          throw new HttpError(422, 'invalid_input', 'Un muro lungo zero non ferma niente');
        }

        const { rows } = await context.pool.query<WallRow>(
          `UPDATE scene_walls
              SET ax = $3, ay = $4, bx = $5, by = $6,
                  kind = COALESCE($7, kind), door_state = COALESCE($8, door_state),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, scene_id, ax, ay, bx, by, kind, door_state, created_at, updated_at, version`,
          [wall.id, input.version, ax, ay, bx, by, input.kind ?? null, input.doorState ?? null],
        );
        const row = rows[0];
        if (!row) {
          throw new HttpError(409, 'version_conflict', 'Il muro è stato modificato altrove', wall);
        }
        await announceVision(context, sceneId, 'wall.changed');
        return { status: 200, body: toWall(row) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/walls/:wallId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { wall, sceneId, role } = await requireWallOwner(context, viewer, params.wallId ?? '');
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master può eliminare i muri');
        }
        await context.pool.query('DELETE FROM scene_walls WHERE id = $1', [wall.id]);
        await announceVision(context, sceneId, 'wall.changed');
        return { status: 200, body: { ok: true } };
      },
    },

    {
      /**
       * Aprire e chiudere una porta.
       *
       * Il Game Master può sempre. Un giocatore può se una delle sue pedine è a
       * portata di mano e la porta non è bloccata: è un gesto di gioco, non una
       * modifica della mappa.
       */
      method: 'POST',
      pattern: '/api/walls/:wallId/door',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { wall, sceneId, role } = await requireWallOwner(context, viewer, params.wallId ?? '');
        const input = parseBody(z.object({ state: doorStateSchema }), request.body);
        if (wall.kind !== 'door') {
          throw new HttpError(422, 'invalid_input', 'Questo muro non è una porta');
        }

        if (role !== 'game_master') {
          if (wall.doorState === 'locked' || input.state === 'locked') {
            throw new HttpError(403, 'forbidden', 'La porta è bloccata');
          }
          const vision = await loadSceneVisionContext(context, sceneId);
          const tokens = await loadAllTokens(context, sceneId);
          const mine = await controlledTokens(context, viewer.id, role, tokens);
          const reachPx = metersToPixels(DOOR_REACH_METERS, vision.grid);
          const within = mine.some(
            (token) =>
              distanceToSegment(
                { x: token.x, y: token.y },
                { x: wall.ax, y: wall.ay },
                { x: wall.bx, y: wall.by },
              ) <=
              reachPx + (token.sizeInCells * vision.grid.cellSizePx) / 2,
          );
          if (!within) {
            throw new HttpError(403, 'forbidden', 'Nessuna delle tue pedine arriva alla porta');
          }
        }

        const { rows } = await context.pool.query<WallRow>(
          `UPDATE scene_walls SET door_state = $2, updated_at = now(), version = version + 1
            WHERE id = $1
        RETURNING id, scene_id, ax, ay, bx, by, kind, door_state, created_at, updated_at, version`,
          [wall.id, input.state],
        );
        const row = rows[0];
        if (!row) throw new HttpError(404, 'not_found', 'Muro non trovato');
        await announceVision(context, sceneId, 'wall.changed');
        return { status: 200, body: toWall(row) };
      },
    },

    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId/lights',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const lights = await loadLights(context, access.sceneId);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: lights };
      },
    },

    {
      method: 'POST',
      pattern: '/api/scenes/:sceneId/lights',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(createLightInputSchema, request.body);

        if (input.tokenId) await requireTokenInScene(context, access.sceneId, input.tokenId);

        const { rows } = await context.pool.query<LightRow>(
          `INSERT INTO scene_lights
             (scene_id, token_id, name, x, y, bright_radius_meters, dim_radius_meters,
              color, enabled, remaining_minutes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, scene_id, token_id, name, x, y, bright_radius_meters, dim_radius_meters,
                     color, enabled, remaining_minutes, created_at, updated_at, version`,
          [
            access.sceneId,
            input.tokenId ?? null,
            input.name,
            input.x,
            input.y,
            input.brightRadiusMeters,
            input.dimRadiusMeters,
            input.color,
            input.enabled,
            input.remainingMinutes ?? null,
          ],
        );
        const row = rows[0];
        if (!row) throw new Error('creazione luce fallita');
        await announceVision(context, access.sceneId, 'light.changed');
        return { status: 201, body: toLight(row) };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/lights/:lightId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { light, sceneId, role } = await requireLightOwner(
          context,
          viewer,
          params.lightId ?? '',
        );
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master può modificare le luci');
        }
        const input = parseBody(updateLightInputSchema, request.body);
        if (input.tokenId) await requireTokenInScene(context, sceneId, input.tokenId);

        const { rows } = await context.pool.query<LightRow>(
          `UPDATE scene_lights
              SET name                 = COALESCE($3, name),
                  token_id             = CASE WHEN $4::boolean THEN $5::uuid ELSE token_id END,
                  x                    = COALESCE($6, x),
                  y                    = COALESCE($7, y),
                  bright_radius_meters = COALESCE($8, bright_radius_meters),
                  dim_radius_meters    = COALESCE($9, dim_radius_meters),
                  color                = COALESCE($10, color),
                  enabled              = COALESCE($11, enabled),
                  remaining_minutes    = CASE WHEN $12::boolean THEN $13::double precision
                                              ELSE remaining_minutes END,
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, scene_id, token_id, name, x, y, bright_radius_meters, dim_radius_meters,
                  color, enabled, remaining_minutes, created_at, updated_at, version`,
          [
            light.id,
            input.version,
            input.name ?? null,
            'tokenId' in input,
            input.tokenId ?? null,
            input.x ?? null,
            input.y ?? null,
            input.brightRadiusMeters ?? null,
            input.dimRadiusMeters ?? null,
            input.color ?? null,
            input.enabled ?? null,
            'remainingMinutes' in input,
            input.remainingMinutes ?? null,
          ],
        );
        const row = rows[0];
        if (!row) {
          throw new HttpError(409, 'version_conflict', 'La luce è stata modificata altrove', light);
        }
        await announceVision(context, sceneId, 'light.changed');
        return { status: 200, body: toLight(row) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/lights/:lightId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { light, sceneId, role } = await requireLightOwner(
          context,
          viewer,
          params.lightId ?? '',
        );
        if (role !== 'game_master') {
          throw new HttpError(403, 'forbidden', 'Solo il Game Master può eliminare le luci');
        }
        await context.pool.query('DELETE FROM scene_lights WHERE id = $1', [light.id]);
        await announceVision(context, sceneId, 'light.changed');
        return { status: 200, body: { ok: true } };
      },
    },
  ];
}

async function requireTokenInScene(
  context: ServerContext,
  sceneId: string,
  tokenId: string,
): Promise<void> {
  const { rows } = await context.pool.query('SELECT 1 FROM tokens WHERE id = $1 AND scene_id = $2', [
    tokenId,
    sceneId,
  ]);
  if (rows.length === 0) {
    throw new HttpError(422, 'invalid_input', 'La pedina indicata non è in questa scena');
  }
}

async function requireLightOwner(
  context: ServerContext,
  viewer: { id: string },
  lightId: string,
): Promise<{ light: LightSource; sceneId: string; role: CampaignRole }> {
  const { rows } = await context.pool.query<LightRow & { role: CampaignRole }>(
    `SELECT l.id, l.scene_id, l.token_id, l.name, l.x, l.y, l.bright_radius_meters,
            l.dim_radius_meters, l.color, l.enabled, l.remaining_minutes,
            l.created_at, l.updated_at, l.version, m.role
       FROM scene_lights l
       JOIN scenes s ON s.id = l.scene_id AND s.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE l.id = $1`,
    [lightId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Luce non trovata');
  return { light: toLight(row), sceneId: row.scene_id, role: row.role };
}


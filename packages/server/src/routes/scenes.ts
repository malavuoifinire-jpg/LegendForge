import {
  createSceneInputSchema,
  updateGridInputSchema,
  type GridDetection,
  type GridState,
  type Scene,
  type SceneDetail,
  type SceneEvents,
  type CampaignRole,
} from '@legendforge/contracts';
import { DEFAULT_RULE_SET } from '@legendforge/core';
import { requireCampaignAccess, requireGameMaster, requireSceneAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import { createSignedDownload, readStorageConfig } from '../storage/supabase.js';
import {
  emitSceneEvent,
  latestCursor,
  pruneSceneEvents,
  readSceneEvents,
  type EventVisibility,
} from '../events.js';
import { controlLevel } from './tokens.js';
import { parseBody } from '../validate.js';
import { SELECT_MAPS, SOURCE_URL_SECONDS, toMapAsset } from './maps.js';
import { visibleTokensForViewer } from './vision.js';
import type { SceneEvent } from '../events.js';

interface SceneRow {
  id: string;
  campaign_id: string;
  name: string;
  map_asset_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  cell_size_px: number;
  offset_x: number;
  offset_y: number;
  rotation_deg: number;
  meters_per_cell: number;
  snap_enabled: boolean;
  grid_status: GridState['status'];
  grid_version: number;
  token_count: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toGridState(row: SceneRow): GridState {
  return {
    cellSizePx: row.cell_size_px,
    offsetX: row.offset_x,
    offsetY: row.offset_y,
    rotationDeg: row.rotation_deg,
    metersPerCell: row.meters_per_cell,
    snapEnabled: row.snap_enabled,
    status: row.grid_status,
    version: row.grid_version,
  };
}

function toScene(row: SceneRow): Scene {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    mapAssetId: row.map_asset_id,
    grid: toGridState(row),
    tokenCount: row.token_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_SCENES = `
  SELECT s.id, s.campaign_id, s.name, s.map_asset_id,
         s.created_at, s.updated_at, s.version,
         g.cell_size_px, g.offset_x, g.offset_y, g.rotation_deg,
         g.meters_per_cell, g.snap_enabled, g.status AS grid_status, g.version AS grid_version,
         (SELECT count(*)::int FROM tokens t WHERE t.scene_id = s.id) AS token_count
    FROM scenes s
    JOIN grid_configurations g ON g.scene_id = s.id
   WHERE s.deleted_at IS NULL`;

/**
 * Passa gli aggiornamenti delle pedine dallo stesso filtro della lettura
 * completa.
 *
 * Senza questo passaggio il registro degli eventi sarebbe una porta di
 * servizio: la scena non consegna una pedina fuori dal campo visivo, ma
 * l'aggiornamento della sua posizione arriverebbe lo stesso a tutti. Una
 * pedina che non si vede diventa qui una pedina sparita, che è esattamente
 * quello che chi guarda ha diritto di sapere.
 */
async function filterTokenEvents(
  context: ServerContext,
  access: { sceneId: string; role: CampaignRole; campaignId: string },
  userId: string,
  events: SceneEvent[],
): Promise<SceneEvent[]> {
  if (access.role === 'game_master') return events;
  if (!events.some((event) => event.kind === 'token.upserted')) return events;

  const { tokens } = await visibleTokensForViewer(context, access.sceneId, userId, access.role);
  const visible = new Map(tokens.map((token) => [token.id, token]));

  return events.map((event) => {
    if (event.kind !== 'token.upserted') return event;
    const incoming = event.payload as { id?: unknown };
    const id = typeof incoming?.id === 'string' ? incoming.id : null;
    if (!id) return event;
    const current = visible.get(id);
    if (!current) return { ...event, kind: 'token.removed' as const, payload: { id } };
    // Si consegna lo stato attuale, non quello di quando l'evento è nato: fra
    // i due potrebbe essere passato altro.
    return { ...event, payload: current };
  });
}

export function sceneRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/scenes',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const { rows } = await context.pool.query<SceneRow>(
          `${SELECT_SCENES} AND s.campaign_id = $1 ORDER BY s.created_at DESC`,
          [access.campaignId],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toScene) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/scenes',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(createSceneInputSchema, request.body);

        let detection: GridDetection | null = null;
        if (input.mapAssetId) {
          const { rows } = await context.pool.query<{ detection: unknown }>(
            `SELECT detection FROM map_assets WHERE id = $1 AND campaign_id = $2`,
            [input.mapAssetId, access.campaignId],
          );
          if (rows.length === 0) throw new HttpError(404, 'not_found', 'Mappa non trovata');
          detection = (rows[0]?.detection as GridDetection | null) ?? null;
        }

        // Il rilevamento diventa una proposta, mai una configurazione
        // confermata: la conferma è un gesto esplicito del Game Master.
        const threshold = DEFAULT_RULE_SET.grid.autoDetectAcceptThreshold;
        const usable =
          input.applyDetection &&
          detection !== null &&
          detection.cellSizePx !== null &&
          detection.confidence >= threshold;

        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          const scene = await client.query<{ id: string }>(
            `INSERT INTO scenes (campaign_id, name, map_asset_id) VALUES ($1, $2, $3) RETURNING id`,
            [access.campaignId, input.name, input.mapAssetId ?? null],
          );
          const sceneId = scene.rows[0]?.id;
          if (!sceneId) throw new Error('creazione scena fallita');

          await client.query(
            `INSERT INTO grid_configurations
               (scene_id, cell_size_px, offset_x, offset_y, rotation_deg,
                meters_per_cell, snap_enabled, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              sceneId,
              usable ? detection!.cellSizePx : 64,
              usable ? (detection!.offsetX ?? 0) : 0,
              usable ? (detection!.offsetY ?? 0) : 0,
              usable ? (detection!.rotationDeg ?? 0) : 0,
              DEFAULT_RULE_SET.grid.defaultMetersPerCell,
              DEFAULT_RULE_SET.grid.defaultSnapEnabled,
              usable ? 'suggested' : 'unconfigured',
            ],
          );
          await client.query('COMMIT');

          const { rows } = await context.pool.query<SceneRow>(`${SELECT_SCENES} AND s.id = $1`, [
            sceneId,
          ]);
          const row = rows[0];
          if (!row) throw new Error('scena non leggibile dopo la creazione');
          return { status: 201, body: toScene(row) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },

    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');

        const sceneRows = await context.pool.query<SceneRow>(`${SELECT_SCENES} AND s.id = $1`, [
          access.sceneId,
        ]);
        const scene = sceneRows.rows[0];
        if (!scene) throw new HttpError(404, 'not_found', 'Scena non trovata');

        // Le pedine nascoste o fuori dal campo visivo non vengono marcate: per
        // chi non è Game Master non compaiono affatto nella risposta. La regola
        // sta in un posto solo, condiviso con il calcolo del campo visivo.
        const { tokens, vision } = await visibleTokensForViewer(
          context,
          access.sceneId,
          viewer.id,
          access.role,
        );

        let map = null;
        let mapSource = null;
        if (scene.map_asset_id) {
          const mapRows = await context.pool.query(`${SELECT_MAPS} WHERE m.id = $1`, [
            scene.map_asset_id,
          ]);
          const mapRow = mapRows.rows[0];
          if (mapRow) {
            map = toMapAsset(mapRow as Parameters<typeof toMapAsset>[0]);
            const config = readStorageConfig(context.env);
            if (config) {
              const keyRows = await context.pool.query<{ storage_key: string }>(
                'SELECT storage_key FROM assets WHERE id = $1',
                [map.assetId],
              );
              const key = keyRows.rows[0]?.storage_key;
              if (key) {
                mapSource = await createSignedDownload(config, key, SOURCE_URL_SECONDS).catch(
                  () => null,
                );
              }
            }
          }
        }

        // Quali pedine chi guarda può effettivamente muovere: lo dice il
        // server, così l'interfaccia non deve indovinarlo.
        const controllableTokenIds: string[] = [];
        for (const token of tokens) {
          const level = await controlLevel(context, viewer.id, access.role, token.actorId);
          if (level !== 'none') controllableTokenIds.push(token.id);
        }

        const body: SceneDetail = {
          ...toScene(scene),
          map,
          mapSource,
          tokens,
          vision: vision.settings,
          eventCursor: await latestCursor(context.pool, access.sceneId),
          viewerRole: access.role,
          controllableTokenIds,
        };
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/scenes/:sceneId/grid',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(updateGridInputSchema, request.body);

        const status = input.confirmed === true ? 'confirmed' : undefined;
        const { rows } = await context.pool.query<{ version: number }>(
          `UPDATE grid_configurations
              SET cell_size_px    = COALESCE($3, cell_size_px),
                  offset_x        = COALESCE($4, offset_x),
                  offset_y        = COALESCE($5, offset_y),
                  rotation_deg    = COALESCE($6, rotation_deg),
                  meters_per_cell = COALESCE($7, meters_per_cell),
                  snap_enabled    = COALESCE($8, snap_enabled),
                  status          = COALESCE($9, status),
                  updated_at = now(), version = version + 1
            WHERE scene_id = $1 AND version = $2
        RETURNING version`,
          [
            access.sceneId,
            input.version,
            input.cellSizePx ?? null,
            input.offsetX ?? null,
            input.offsetY ?? null,
            input.rotationDeg ?? null,
            input.metersPerCell ?? null,
            input.snapEnabled ?? null,
            status ?? null,
          ],
        );

        if (rows.length === 0) {
          // Nessuna riga aggiornata: la griglia è cambiata sotto di noi.
          const current = await context.pool.query<SceneRow>(`${SELECT_SCENES} AND s.id = $1`, [
            access.sceneId,
          ]);
          throw new HttpError(
            409,
            'version_conflict',
            'La griglia è stata modificata altrove',
            current.rows[0] ? toGridState(current.rows[0]) : undefined,
          );
        }

        const updated = await context.pool.query<SceneRow>(`${SELECT_SCENES} AND s.id = $1`, [
          access.sceneId,
        ]);
        const row = updated.rows[0];
        if (!row) throw new Error('scena non leggibile dopo l aggiornamento');
        const gridState = toGridState(row);
        await emitSceneEvent(context.pool, access.sceneId, 'grid.updated', gridState, 'all');
        void pruneSceneEvents(context.pool, access.sceneId);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: gridState };
      },
    },
    {
      /**
       * Attesa lunga: la richiesta resta aperta finché non succede qualcosa,
       * fino a un tetto oltre il quale il client riprova. Gli aggiornamenti
       * passano dalla stessa autorizzazione della lettura completa, quindi
       * esiste un solo posto in cui si decide che cosa una persona può vedere.
       */
      method: 'GET',
      pattern: '/api/scenes/:sceneId/events',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        const since = Number.parseInt(request.query.since ?? '0', 10);
        const cursor = Number.isFinite(since) && since >= 0 ? since : 0;
        const visibilities: EventVisibility[] =
          access.role === 'game_master' ? ['all', 'game_master'] : ['all'];
        const wait = request.query.wait !== '0';

        const deadline = Date.now() + (wait ? HOLD_MS : 0);
        for (;;) {
          const raw = await readSceneEvents(context.pool, access.sceneId, cursor, visibilities);
          if (raw.length > 0) {
            const last = raw[raw.length - 1];
            const events = await filterTokenEvents(context, access, viewer.id, raw);
            const body: SceneEvents = { cursor: last ? last.id : cursor, events };
            return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
          }
          if (Date.now() >= deadline) {
            const body: SceneEvents = { cursor, events: [] };
            return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
          }
          await sleep(POLL_INTERVAL_MS);
        }
      },
    },
  ];
}

/** Quanto a lungo la richiesta resta in attesa prima di tornare a mani vuote. */
const HOLD_MS = 20_000;
const POLL_INTERVAL_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

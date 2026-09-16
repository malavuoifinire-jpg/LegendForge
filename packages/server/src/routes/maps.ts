import {
  finalizeMapInputSchema,
  requestUploadInputSchema,
  SUPPORTED_MAP_MIME_TYPES,
  type MapAsset,
  type UploadTicket,
} from '@legendforge/contracts';
import { requireCampaignAccess, requireGameMaster } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { HttpError, type Route } from '../http.js';
import {
  createSignedDownload,
  createSignedUpload,
  deleteObject,
  getObjectInfo,
  readStorageConfig,
  StorageError,
} from '../storage/supabase.js';
import { parseBody } from '../validate.js';

const UPLOAD_TICKET_SECONDS = 15 * 60;
export const SOURCE_URL_SECONDS = 60 * 60;

interface MapRow {
  id: string;
  campaign_id: string;
  asset_id: string;
  name: string;
  detection: unknown;
  mime_type: string;
  width_px: number | null;
  height_px: number | null;
  byte_size: number;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toMapAsset(row: MapRow): MapAsset {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    assetId: row.asset_id,
    name: row.name,
    mimeType: row.mime_type,
    widthPx: row.width_px ?? 0,
    heightPx: row.height_px ?? 0,
    byteSize: row.byte_size,
    detection: (row.detection as MapAsset['detection']) ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export const SELECT_MAPS = `
  SELECT m.id, m.campaign_id, m.asset_id, m.name, m.detection,
         a.mime_type, a.width_px, a.height_px, a.byte_size,
         m.created_at, m.updated_at, m.version
    FROM map_assets m
    JOIN assets a ON a.id = m.asset_id`;

function extensionFor(mimeType: string): string {
  return mimeType === 'image/png' ? 'png' : 'jpg';
}

function storage(context: ServerContext) {
  const config = readStorageConfig(context.env);
  if (!config) {
    throw new HttpError(503, 'storage_unavailable', 'Lo storage non è configurato');
  }
  return config;
}

export function mapRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/campaigns/:campaignId/maps',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireCampaignAccess(context, viewer, params.campaignId ?? '');
        const { rows } = await context.pool.query<MapRow>(
          `${SELECT_MAPS} WHERE m.campaign_id = $1 ORDER BY m.created_at DESC`,
          [access.campaignId],
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: rows.map(toMapAsset) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/maps/upload',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(requestUploadInputSchema, request.body);

        if (input.byteSize > context.env.maxUploadBytes) {
          throw new HttpError(
            413,
            'file_too_large',
            `Il file supera il limite di ${Math.round(context.env.maxUploadBytes / 1024 / 1024)} MB`,
          );
        }

        const config = storage(context);
        const inserted = await context.pool.query<{ id: string }>(
          `INSERT INTO assets (campaign_id, kind, storage_key, mime_type, byte_size, uploaded_by)
           VALUES ($1, 'map', $2, $3, $4, $5) RETURNING id`,
          // La chiave definitiva contiene l'identificatore, che non conosciamo
          // prima dell'inserimento: si scrive subito dopo.
          [access.campaignId, `pending/${crypto.randomUUID()}`, input.mimeType, input.byteSize, viewer.id],
        );
        const assetId = inserted.rows[0]?.id;
        if (!assetId) throw new Error('creazione asset fallita');

        // Il percorso lo decide il server: il client non sceglie dove scrivere.
        const objectPath = `campaigns/${access.campaignId}/maps/${assetId}.${extensionFor(input.mimeType)}`;
        await context.pool.query(
          `UPDATE assets SET storage_key = $2, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [assetId, objectPath],
        );

        try {
          const signed = await createSignedUpload(config, objectPath);
          const ticket: UploadTicket = {
            assetId,
            uploadUrl: signed.uploadUrl,
            token: signed.token,
            expiresAt: new Date(Date.now() + UPLOAD_TICKET_SECONDS * 1000).toISOString(),
          };
          return { status: 201, headers: { 'Cache-Control': 'no-store' }, body: ticket };
        } catch (error) {
          await context.pool.query('DELETE FROM assets WHERE id = $1', [assetId]);
          if (error instanceof StorageError) {
            throw new HttpError(502, 'storage_error', `Storage: ${error.message}`);
          }
          throw error;
        }
      },
    },

    {
      method: 'POST',
      pattern: '/api/campaigns/:campaignId/maps',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = requireGameMaster(
          await requireCampaignAccess(context, viewer, params.campaignId ?? ''),
        );
        const input = parseBody(finalizeMapInputSchema, request.body);
        const config = storage(context);

        const assetRows = await context.pool.query<{
          id: string;
          storage_key: string;
          mime_type: string;
          status: string;
        }>(
          `SELECT id, storage_key, mime_type, status FROM assets
            WHERE id = $1 AND campaign_id = $2 AND kind = 'map'`,
          [input.assetId, access.campaignId],
        );
        const asset = assetRows.rows[0];
        if (!asset) throw new HttpError(404, 'not_found', 'Caricamento non trovato');
        if (asset.status === 'ready') {
          throw new HttpError(409, 'already_finalized', 'Questo caricamento è già stato concluso');
        }

        // I metadati veri li legge il server dallo storage: quelli dichiarati
        // dal browser non sono una fonte attendibile.
        const info = await getObjectInfo(config, asset.storage_key).catch((error: unknown) => {
          throw new HttpError(
            502,
            'storage_error',
            `Storage: ${error instanceof Error ? error.message : 'errore'}`,
          );
        });
        if (!info) {
          throw new HttpError(409, 'upload_missing', 'Il file non risulta caricato');
        }
        if (info.byteSize > context.env.maxUploadBytes) {
          await deleteObject(config, asset.storage_key);
          await context.pool.query('DELETE FROM assets WHERE id = $1', [asset.id]);
          throw new HttpError(413, 'file_too_large', 'Il file supera il limite consentito');
        }
        const actualMime = info.mimeType ?? asset.mime_type;
        if (!SUPPORTED_MAP_MIME_TYPES.includes(actualMime as (typeof SUPPORTED_MAP_MIME_TYPES)[number])) {
          await deleteObject(config, asset.storage_key);
          await context.pool.query('DELETE FROM assets WHERE id = $1', [asset.id]);
          throw new HttpError(415, 'unsupported_type', `Tipo di file non ammesso: ${actualMime}`);
        }

        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE assets
                SET status = 'ready', byte_size = $2, mime_type = $3,
                    width_px = $4, height_px = $5, updated_at = now(), version = version + 1
              WHERE id = $1`,
            [asset.id, info.byteSize, actualMime, input.widthPx, input.heightPx],
          );
          const map = await client.query<{ id: string }>(
            `INSERT INTO map_assets (campaign_id, asset_id, name, detection)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [access.campaignId, asset.id, input.name, input.detection ?? null],
          );
          await client.query('COMMIT');

          const { rows } = await context.pool.query<MapRow>(`${SELECT_MAPS} WHERE m.id = $1`, [
            map.rows[0]?.id,
          ]);
          const row = rows[0];
          if (!row) throw new Error('mappa non leggibile dopo la creazione');
          return { status: 201, body: toMapAsset(row) };
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
      pattern: '/api/maps/:mapId/source',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const { rows } = await context.pool.query<{ storage_key: string }>(
          `SELECT a.storage_key
             FROM map_assets m
             JOIN assets a ON a.id = m.asset_id
             JOIN campaign_memberships cm
               ON cm.campaign_id = m.campaign_id AND cm.user_id = $2 AND cm.status = 'active'
            WHERE m.id = $1`,
          [params.mapId, viewer.id],
        );
        const row = rows[0];
        if (!row) throw new HttpError(404, 'not_found', 'Mappa non trovata');
        const signed = await createSignedDownload(storage(context), row.storage_key, SOURCE_URL_SECONDS);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: signed };
      },
    },
  ];
}

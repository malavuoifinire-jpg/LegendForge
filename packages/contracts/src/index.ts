import { z } from 'zod';
import { MAX_ROTATION_DEG, MIN_CELL_SIZE_PX, RULESET_SCHEMA_VERSION } from '@legendforge/core';

/**
 * Versione dello schema dell'API pubblica e dei pacchetti di import/export.
 * Va incrementata a ogni cambiamento non retrocompatibile.
 */
export const API_SCHEMA_VERSION = 1 as const;

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });
export const finiteNumber = z.number().finite();

/** Contatore di versione per il controllo della concorrenza ottimistica. */
export const entityVersionSchema = z.number().int().min(1);

export const entityMetaSchema = z.object({
  id: uuidSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  version: entityVersionSchema,
});
export type EntityMeta = z.infer<typeof entityMetaSchema>;

/** Corpo restituito da ogni risposta di errore. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'Colore esadecimale non valido, atteso #rrggbb');

/* -------------------------------- griglia -------------------------------- */

export const gridConfigurationSchema = z.object({
  cellSizePx: z.number().finite().min(MIN_CELL_SIZE_PX).max(4096),
  offsetX: finiteNumber.min(-4096).max(4096),
  offsetY: finiteNumber.min(-4096).max(4096),
  rotationDeg: finiteNumber.min(-MAX_ROTATION_DEG).max(MAX_ROTATION_DEG),
  metersPerCell: z.number().finite().positive().max(1000),
  snapEnabled: z.boolean(),
});
export type GridConfigurationInput = z.infer<typeof gridConfigurationSchema>;

export const diagonalRuleSchema = z.enum(['equidistant', 'alternating', 'euclidean']);

export const ruleSetSchema = z.object({
  schemaVersion: z.literal(RULESET_SCHEMA_VERSION),
  grid: z.object({
    kind: z.literal('square'),
    defaultMetersPerCell: z.number().positive().max(1000),
    defaultSnapEnabled: z.boolean(),
    autoDetectAcceptThreshold: z.number().min(0).max(1),
  }),
  movement: z.object({
    diagonalRule: diagonalRuleSchema,
    difficultTerrainMultiplier: z.number().min(1).max(10),
    enforceBudget: z.boolean(),
    allowGameMasterOverride: z.boolean(),
    jumpSegmentCostMeters: z.number().min(0),
  }),
  vision: z.object({
    defaultDarkvisionMeters: z.number().min(0),
    extendedDarkvisionMeters: z.number().min(0),
    torchBrightRadiusMeters: z.number().min(0),
    torchDimRadiusMeters: z.number().min(0),
  }),
  units: z.object({
    system: z.literal('metric'),
    displayUnit: z.literal('meters'),
    displayPrecision: z.number().int().min(0).max(3),
  }),
});

/* -------------------------------- identita ------------------------------- */

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 64;

/**
 * Un PIN troppo prevedibile non protegge nulla: rifiutiamo le sequenze banali
 * al momento della scelta, invece di scoprirlo dopo.
 */
export const pinSchema = z
  .string()
  .min(PIN_MIN_LENGTH, `Il PIN deve avere almeno ${PIN_MIN_LENGTH} caratteri`)
  .max(PIN_MAX_LENGTH)
  .refine((value) => new Set(value).size > 1, 'Il PIN non può essere un carattere ripetuto')
  .refine((value) => !/^(0123456789|123456789|12345678|1234567|123456|987654321|654321)/u.test(value),
    'Il PIN non può essere una sequenza banale');

export const viewerSchema = z.object({
  id: uuidSchema,
  displayName: z.string(),
  isOwner: z.boolean(),
});
export type Viewer = z.infer<typeof viewerSchema>;

export const sessionStateSchema = z.object({
  /** True se qualcuno ha già rivendicato questa istanza con un PIN. */
  instanceClaimed: z.boolean(),
  viewer: viewerSchema.nullable(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const setupInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  pin: pinSchema,
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const setupResultSchema = z.object({
  viewer: viewerSchema,
  /** Mostrato una sola volta: non viene mai restituito di nuovo. */
  recoveryCode: z.string(),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

export const loginInputSchema = z.object({ pin: z.string().min(1).max(PIN_MAX_LENGTH) });
export type LoginInput = z.infer<typeof loginInputSchema>;

export const recoverInputSchema = z.object({
  recoveryCode: z.string().min(1).max(80),
  newPin: pinSchema,
});
export type RecoverInput = z.infer<typeof recoverInputSchema>;

/* -------------------------------- campagne ------------------------------- */

export const MAX_PLAYER_SLOTS = 8;

export const campaignRoleSchema = z.enum(['game_master', 'player']);
export type CampaignRole = z.infer<typeof campaignRoleSchema>;

export const createCampaignInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().default(''),
  playerSlots: z.number().int().min(1).max(MAX_PLAYER_SLOTS),
});
export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;

export const campaignSchema = entityMetaSchema.extend({
  name: z.string(),
  description: z.string(),
  playerSlots: z.number().int().min(1).max(MAX_PLAYER_SLOTS),
  ownerUserId: uuidSchema,
  ruleSet: ruleSetSchema,
  /** Ruolo di chi sta guardando dentro questa campagna. */
  viewerRole: campaignRoleSchema,
  sceneCount: z.number().int().nonnegative(),
});
export type Campaign = z.infer<typeof campaignSchema>;

/* ------------------------------ mappe e file ------------------------------ */

export const SUPPORTED_MAP_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type SupportedMapMimeType = (typeof SUPPORTED_MAP_MIME_TYPES)[number];

export const MAX_MAP_DIMENSION_PX = 20_000;

/** Esito del rilevamento automatico, calcolato nel browser e validato qui. */
export const gridDetectionSchema = z.object({
  cellSizePx: z.number().positive().max(4096).nullable(),
  offsetX: finiteNumber.min(-4096).max(4096).nullable(),
  offsetY: finiteNumber.min(-4096).max(4096).nullable(),
  rotationDeg: finiteNumber.min(-15).max(15).nullable(),
  confidence: z.number().min(0).max(1),
  axisAgreement: z.number().min(0).max(1),
  analyzedWidth: z.number().int().positive(),
  analyzedHeight: z.number().int().positive(),
  elapsedMs: z.number().min(0),
});
export type GridDetection = z.infer<typeof gridDetectionSchema>;

/** Richiesta di un permesso di caricamento a tempo. */
export const requestUploadInputSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(SUPPORTED_MAP_MIME_TYPES),
  byteSize: z.number().int().positive(),
});
export type RequestUploadInput = z.infer<typeof requestUploadInputSchema>;

export const uploadTicketSchema = z.object({
  assetId: uuidSchema,
  /** Indirizzo a cui il browser invia il file. */
  uploadUrl: z.string(),
  token: z.string(),
  /** Scadenza indicativa del permesso. */
  expiresAt: isoDateSchema,
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

/** Conclusione del caricamento: il server rilegge i metadati reali. */
export const finalizeMapInputSchema = z.object({
  assetId: uuidSchema,
  name: z.string().trim().min(1).max(160),
  widthPx: z.number().int().positive().max(MAX_MAP_DIMENSION_PX),
  heightPx: z.number().int().positive().max(MAX_MAP_DIMENSION_PX),
  detection: gridDetectionSchema.nullable().optional(),
});
export type FinalizeMapInput = z.infer<typeof finalizeMapInputSchema>;

export const mapAssetSchema = entityMetaSchema.extend({
  campaignId: uuidSchema,
  assetId: uuidSchema,
  name: z.string(),
  mimeType: z.string(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  byteSize: z.number().int().nonnegative(),
  detection: gridDetectionSchema.nullable(),
});
export type MapAsset = z.infer<typeof mapAssetSchema>;

export const signedSourceSchema = z.object({
  url: z.string(),
  expiresAt: isoDateSchema,
});
export type SignedSource = z.infer<typeof signedSourceSchema>;

/* ---------------------------------- scene --------------------------------- */

export const gridStatusSchema = z.enum(['unconfigured', 'suggested', 'confirmed']);
export type GridStatus = z.infer<typeof gridStatusSchema>;

export const gridStateSchema = gridConfigurationSchema.extend({
  status: gridStatusSchema,
  /** Versione della sola griglia, per aggiornamenti mirati. */
  version: entityVersionSchema,
});
export type GridState = z.infer<typeof gridStateSchema>;

export const tokenDispositionSchema = z.enum(['friendly', 'neutral', 'hostile']);
export type TokenDisposition = z.infer<typeof tokenDispositionSchema>;

export const tokenSchema = entityMetaSchema.extend({
  sceneId: uuidSchema,
  actorId: uuidSchema.nullable(),
  name: z.string(),
  /** Centro della pedina in pixel dell'immagine della mappa. */
  x: finiteNumber,
  y: finiteNumber,
  sizeInCells: z.number().positive().max(20),
  rotationDeg: finiteNumber,
  color: hexColorSchema,
  disposition: tokenDispositionSchema,
  hidden: z.boolean(),
});
export type Token = z.infer<typeof tokenSchema>;

export const createTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  x: finiteNumber,
  y: finiteNumber,
  sizeInCells: z.number().positive().max(20).default(1),
  color: hexColorSchema.default('#60a5fa'),
  disposition: tokenDispositionSchema.default('neutral'),
  hidden: z.boolean().default(false),
  /** Se true il server aggancia la posizione alla griglia della scena. */
  snapToGrid: z.boolean().default(true),
});
export type CreateTokenInput = z.infer<typeof createTokenInputSchema>;

export const updateTokenInputSchema = z.object({
  /** Versione letta dal client: l'aggiornamento è rifiutato se obsoleta. */
  version: entityVersionSchema,
  name: z.string().trim().min(1).max(120).optional(),
  x: finiteNumber.optional(),
  y: finiteNumber.optional(),
  sizeInCells: z.number().positive().max(20).optional(),
  rotationDeg: finiteNumber.optional(),
  color: hexColorSchema.optional(),
  disposition: tokenDispositionSchema.optional(),
  hidden: z.boolean().optional(),
  snapToGrid: z.boolean().optional(),
});
export type UpdateTokenInput = z.infer<typeof updateTokenInputSchema>;

export const sceneSchema = entityMetaSchema.extend({
  campaignId: uuidSchema,
  name: z.string(),
  mapAssetId: uuidSchema.nullable(),
  grid: gridStateSchema,
  tokenCount: z.number().int().nonnegative(),
});
export type Scene = z.infer<typeof sceneSchema>;

export const sceneDetailSchema = sceneSchema.extend({
  map: mapAssetSchema.nullable(),
  /** URL firmato dell'immagine, valido per poco. */
  mapSource: signedSourceSchema.nullable(),
  tokens: z.array(tokenSchema),
});
export type SceneDetail = z.infer<typeof sceneDetailSchema>;

export const createSceneInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mapAssetId: uuidSchema.nullable().optional(),
  /** Applica il rilevamento della mappa come proposta iniziale. */
  applyDetection: z.boolean().default(true),
});
export type CreateSceneInput = z.infer<typeof createSceneInputSchema>;

export const updateGridInputSchema = gridConfigurationSchema.partial().extend({
  /** Versione della griglia letta dal client. */
  version: entityVersionSchema,
  /** Conferma esplicita del Game Master. */
  confirmed: z.boolean().optional(),
});
export type UpdateGridInput = z.infer<typeof updateGridInputSchema>;

/* --------------------------------- stato --------------------------------- */

/** Esito del controllo di stato del servizio. */
export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  apiSchemaVersion: z.literal(API_SCHEMA_VERSION),
  serverTime: isoDateSchema,
  /** Nome del commit o della build, quando disponibile. */
  build: z.string().nullable(),
  region: z.string().nullable(),
  database: z.object({
    configured: z.boolean(),
    reachable: z.boolean(),
    /** Latenza della query di verifica, in millisecondi. */
    latencyMs: z.number().nullable(),
    serverVersion: z.string().nullable(),
    /** Numero di migrazioni applicate, null se la tabella non esiste ancora. */
    migrationsApplied: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  storage: z.object({
    configured: z.boolean(),
    bucket: z.string(),
    /** Il bucket esiste ed è utilizzabile. */
    ready: z.boolean(),
    /** Creato adesso da questa istanza. */
    createdNow: z.boolean(),
    /** true è un problema: le mappe sarebbero leggibili da chiunque. */
    publicBucket: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
  migrations: z.object({
    /** Migrazioni previste dal codice in esecuzione. */
    expected: z.number().int().nonnegative(),
    /** Applicate durante l'avvio di questa istanza. */
    appliedNow: z.array(z.string()),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});
export type Health = z.infer<typeof healthSchema>;

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

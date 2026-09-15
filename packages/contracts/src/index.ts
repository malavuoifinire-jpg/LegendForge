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
});
export type Health = z.infer<typeof healthSchema>;

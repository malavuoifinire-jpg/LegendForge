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
  /** True se chiunque può crearsi un account su questa istanza. */
  openRegistration: z.boolean(),
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

export const registerInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  pin: pinSchema,
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  /**
   * Nome visualizzato. Assente significa il proprietario dell'istanza: è la
   * scorciatoia per chi ha configurato il servizio e non ha un invito.
   */
  displayName: z.string().trim().min(1).max(80).optional(),
  pin: z.string().min(1).max(PIN_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const recoverInputSchema = z.object({
  recoveryCode: z.string().min(1).max(80),
  newPin: pinSchema,
});
export type RecoverInput = z.infer<typeof recoverInputSchema>;

/* --------------------------------- inviti -------------------------------- */

export const createInviteInputSchema = z.object({
  label: z.string().trim().max(80).default(''),
  maxUses: z.number().int().min(1).max(8).default(1),
  /** Durata in ore; assente significa senza scadenza. */
  expiresInHours: z.number().int().min(1).max(24 * 30).nullable().default(72),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

export const inviteSchema = entityMetaSchema.extend({
  campaignId: uuidSchema,
  label: z.string(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  expiresAt: isoDateSchema.nullable(),
  revokedAt: isoDateSchema.nullable(),
  /** Stato calcolato: comodo da mostrare, ma deciso dal server. */
  status: z.enum(['active', 'exhausted', 'expired', 'revoked']),
});
export type Invite = z.infer<typeof inviteSchema>;

/** Restituito una sola volta, alla creazione: il segreto non è più recuperabile. */
export const createdInviteSchema = inviteSchema.extend({
  /** Percorso da comporre con l'indirizzo del sito. */
  joinPath: z.string(),
  /**
   * Indirizzo completo, quando il servizio conosce il proprio dominio stabile.
   * Va preferito a `joinPath`: un invito non deve mai puntare all'anteprima di
   * una pubblicazione.
   */
  joinUrl: z.string().nullable(),
  token: z.string(),
});
export type CreatedInvite = z.infer<typeof createdInviteSchema>;

/** Anteprima mostrata a chi apre un link d'invito. */
export const invitePreviewSchema = z.object({
  valid: z.boolean(),
  reason: z.enum(['ok', 'not_found', 'revoked', 'expired', 'exhausted', 'full']),
  campaignName: z.string().nullable(),
  seatsLeft: z.number().int().nonnegative().nullable(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const acceptInviteInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  pin: pinSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInputSchema>;

/* -------------------------------- membri --------------------------------- */

export const campaignMemberSchema = z.object({
  userId: uuidSchema,
  displayName: z.string(),
  role: z.enum(['game_master', 'player']),
  status: z.enum(['active', 'suspended']),
  joinedAt: isoDateSchema,
  /** Identificatori dei personaggi che questa persona controlla. */
  actorIds: z.array(uuidSchema),
});
export type CampaignMember = z.infer<typeof campaignMemberSchema>;

/* -------------------------------- attori --------------------------------- */

export const actorKindSchema = z.enum(['character', 'monster']);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const actorSchema = entityMetaSchema.extend({
  campaignId: uuidSchema,
  kind: actorKindSchema,
  name: z.string(),
  sizeInCells: z.number().positive().max(20),
  color: hexColorSchema,
  /** Chi lo controlla. Vuoto significa: solo il Game Master. */
  ownerUserIds: z.array(uuidSchema),
});
export type Actor = z.infer<typeof actorSchema>;

export const createActorInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: actorKindSchema.default('character'),
  sizeInCells: z.number().positive().max(20).default(1),
  color: hexColorSchema.default('#60a5fa'),
});
export type CreateActorInput = z.infer<typeof createActorInputSchema>;

export const setActorOwnersInputSchema = z.object({
  userIds: z.array(uuidSchema).max(8),
});
export type SetActorOwnersInput = z.infer<typeof setActorOwnersInputSchema>;

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
  /**
   * Codice con cui si entra nella campagna. Lo vede solo il Game Master:
   * per gli altri è null, perché non è una loro informazione.
   */
  joinCode: z.string().nullable(),
});
export type Campaign = z.infer<typeof campaignSchema>;

export const joinCampaignInputSchema = z.object({
  code: z.string().trim().min(4).max(20),
});
export type JoinCampaignInput = z.infer<typeof joinCampaignInputSchema>;

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

/* -------------------------------- visione -------------------------------- */

/** Limite per richiesta quando si disegna una spezzata di muri. */
export const MAX_WALLS_PER_REQUEST = 500;

export const wallKindSchema = z.enum([
  'opaque',
  'door',
  'window',
  'sight_blocker',
  'movement_blocker',
]);
export type WallKind = z.infer<typeof wallKindSchema>;

export const doorStateSchema = z.enum(['closed', 'open', 'locked']);
export type DoorState = z.infer<typeof doorStateSchema>;

/** Estremi in pixel dell'immagine della mappa, come per le pedine. */
const wallGeometry = {
  ax: finiteNumber,
  ay: finiteNumber,
  bx: finiteNumber,
  by: finiteNumber,
};

export const wallSchema = entityMetaSchema.extend({
  sceneId: uuidSchema,
  ...wallGeometry,
  kind: wallKindSchema,
  doorState: doorStateSchema,
});
export type Wall = z.infer<typeof wallSchema>;

export const createWallInputSchema = z.object({
  ...wallGeometry,
  kind: wallKindSchema.default('opaque'),
  doorState: doorStateSchema.default('closed'),
});
export type CreateWallInput = z.infer<typeof createWallInputSchema>;

/** Una spezzata arriva come più segmenti in una sola richiesta. */
export const createWallsInputSchema = z.object({
  walls: z.array(createWallInputSchema).min(1).max(MAX_WALLS_PER_REQUEST),
});
export type CreateWallsInput = z.infer<typeof createWallsInputSchema>;

export const updateWallInputSchema = z.object({
  version: entityVersionSchema,
  ax: finiteNumber.optional(),
  ay: finiteNumber.optional(),
  bx: finiteNumber.optional(),
  by: finiteNumber.optional(),
  kind: wallKindSchema.optional(),
  doorState: doorStateSchema.optional(),
});
export type UpdateWallInput = z.infer<typeof updateWallInputSchema>;

export const lightSourceSchema = entityMetaSchema.extend({
  sceneId: uuidSchema,
  /** Se valorizzato la luce segue la pedina: una torcia in mano. */
  tokenId: uuidSchema.nullable(),
  name: z.string(),
  x: finiteNumber,
  y: finiteNumber,
  brightRadiusMeters: z.number().nonnegative().max(1000),
  dimRadiusMeters: z.number().nonnegative().max(1000),
  color: hexColorSchema,
  enabled: z.boolean(),
  /** Minuti di autonomia rimasti, null se la luce non si consuma. */
  remainingMinutes: z.number().nonnegative().nullable(),
});
export type LightSource = z.infer<typeof lightSourceSchema>;

export const createLightInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tokenId: uuidSchema.nullable().optional(),
  x: finiteNumber,
  y: finiteNumber,
  brightRadiusMeters: z.number().nonnegative().max(1000).default(6),
  dimRadiusMeters: z.number().nonnegative().max(1000).default(12),
  color: hexColorSchema.default('#ffd9a0'),
  enabled: z.boolean().default(true),
  remainingMinutes: z.number().nonnegative().max(100000).nullable().optional(),
});
export type CreateLightInput = z.infer<typeof createLightInputSchema>;

export const updateLightInputSchema = z.object({
  version: entityVersionSchema,
  name: z.string().trim().min(1).max(120).optional(),
  tokenId: uuidSchema.nullable().optional(),
  x: finiteNumber.optional(),
  y: finiteNumber.optional(),
  brightRadiusMeters: z.number().nonnegative().max(1000).optional(),
  dimRadiusMeters: z.number().nonnegative().max(1000).optional(),
  color: hexColorSchema.optional(),
  enabled: z.boolean().optional(),
  remainingMinutes: z.number().nonnegative().max(100000).nullable().optional(),
});
export type UpdateLightInput = z.infer<typeof updateLightInputSchema>;

/** Impostazioni di visione della scena, di competenza del Game Master. */
export const sceneVisionSettingsSchema = z.object({
  visionEnabled: z.boolean(),
  fogEnabled: z.boolean(),
  ambientDarkness: z.number().min(0).max(1),
  sceneReachMeters: z.number().positive().max(10000),
});
export type SceneVisionSettings = z.infer<typeof sceneVisionSettingsSchema>;

export const updateSceneVisionInputSchema = sceneVisionSettingsSchema.partial().extend({
  /** Versione della scena letta dal client. */
  version: entityVersionSchema,
});
export type UpdateSceneVisionInput = z.infer<typeof updateSceneVisionInputSchema>;

export const imagePointSchema = z.object({ x: finiteNumber, y: finiteNumber });
export type ImagePointDto = z.infer<typeof imagePointSchema>;

/**
 * Che cosa vede una pedina.
 *
 * Il poligono è calcolato dal server: al giocatore non arrivano i muri, quindi
 * dalla risposta non si può ricostruire la pianta della mappa.
 */
export const viewpointSchema = z.object({
  tokenId: uuidSchema,
  origin: imagePointSchema,
  radiusPx: z.number().nonnegative(),
  radiusMeters: z.number().nonnegative(),
  source: z.enum(['normale', 'scurovisione', 'senso speciale', 'luce', 'nessuna']),
  polygon: z.array(imagePointSchema),
});
export type Viewpoint = z.infer<typeof viewpointSchema>;

export const sceneVisionStateSchema = sceneVisionSettingsSchema.extend({
  /** Da quale punto di vista è calcolato: una pedina, o l'onniscienza del GM. */
  perspective: z.enum(['game_master', 'tokens']),
  viewpoints: z.array(viewpointSchema),
  /** Solo per il Game Master: al giocatore arriva null. */
  walls: z.array(wallSchema).nullable(),
  /** Solo per il Game Master: al giocatore arriva null. */
  lights: z.array(lightSourceSchema).nullable(),
  /**
   * Le porte che chi guarda ha davanti agli occhi.
   *
   * Non è una falla nel segreto dei muri: una porta che si vede si vede, e
   * senza saperla lì nessuno potrebbe aprirla. Le porte fuori dal campo visivo
   * non compaiono.
   */
  visibleDoors: z.array(wallSchema),
});
export type SceneVisionState = z.infer<typeof sceneVisionStateSchema>;

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
  /** Personaggio o mostro rappresentato: decide chi può muovere la pedina. */
  actorId: uuidSchema.nullable().optional(),
  x: finiteNumber,
  y: finiteNumber,
  /** Assenti significa: prendili dal personaggio, o usa i valori di base. */
  sizeInCells: z.number().positive().max(20).optional(),
  color: hexColorSchema.optional(),
  disposition: tokenDispositionSchema.default('neutral'),
  hidden: z.boolean().default(false),
  /** Se true il server aggancia la posizione alla griglia della scena. */
  snapToGrid: z.boolean().default(true),
});

export const DEFAULT_TOKEN_SIZE_IN_CELLS = 1;
export const DEFAULT_TOKEN_COLOR = '#94a3b8';
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

export const sceneEventSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum([
    'token.upserted',
    'token.removed',
    'grid.updated',
    'wall.changed',
    'light.changed',
    'vision.changed',
  ]),
  payload: z.unknown(),
  at: isoDateSchema,
});
export type SceneEvent = z.infer<typeof sceneEventSchema>;

export const sceneEventsSchema = z.object({
  /** Ultimo evento consegnato: va rimandato alla richiesta successiva. */
  cursor: z.number().int().nonnegative(),
  events: z.array(sceneEventSchema),
});
export type SceneEvents = z.infer<typeof sceneEventsSchema>;

export const sceneDetailSchema = sceneSchema.extend({
  map: mapAssetSchema.nullable(),
  /** URL firmato dell'immagine, valido per poco. */
  mapSource: signedSourceSchema.nullable(),
  tokens: z.array(tokenSchema),
  /** Impostazioni di visione, così il client sa se disegnare il buio. */
  vision: sceneVisionSettingsSchema,
  /** Punto di partenza per seguire gli aggiornamenti della scena. */
  eventCursor: z.number().int().nonnegative(),
  /** Ruolo di chi guarda, dentro questa campagna. */
  viewerRole: campaignRoleSchema,
  /** Pedine che chi guarda può muovere. */
  controllableTokenIds: z.array(uuidSchema),
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

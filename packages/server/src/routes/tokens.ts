import {
  createTokenInputSchema,
  DEFAULT_TOKEN_COLOR,
  DEFAULT_TOKEN_SIZE_IN_CELLS,
  updateTokenInputSchema,
  type Token,
  type TokenDisposition,
} from '@legendforge/contracts';
import {
  canTraverse,
  mergeRuleSet,
  snapImagePointToFootprint,
  type GridConfiguration,
  type RuleSet,
} from '@legendforge/core';
import { requireGameMaster, requireSceneAccess, requireTokenAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { emitSceneEvent, pruneSceneEvents } from '../events.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';
import { loadWalls, toWallSegment } from '../vision.js';

/**
 * Quanto controllo ha chi guarda su una pedina.
 *
 *  - `full` : il Game Master, che può tutto.
 *  - `move` : chi possiede il personaggio rappresentato. Può spostarlo e
 *             ruotarlo, non rinominarlo, ridimensionarlo o nasconderlo.
 *  - `none` : chiunque altro.
 */
/**
 * Quanto controllo ha chi guarda su una pedina.
 *
 *  - `full`   : tutto.
 *  - `manage` : tutto tranne muoverla. È il Game Master su una pedina affidata
 *               a un giocatore, quando la regola della campagna dice che il
 *               movimento è cosa di chi la possiede. Nascondere, rinominare,
 *               ridimensionare ed eliminare restano suoi: sono gestione della
 *               scena, non il personaggio di qualcun altro che cammina da solo.
 *  - `move`   : solo spostarla e ruotarla. È chi possiede il personaggio.
 *  - `none`   : niente.
 */
export type ControlLevel = 'full' | 'manage' | 'move' | 'none';

export interface TokenControl {
  actorId: string | null;
  /** Il controllo è passato al Game Master: dominio, confusione, possessione. */
  controlledByGameMaster: boolean;
}

/** Le regole della campagna, con i valori mancanti riempiti dai default. */
export async function campaignRules(
  context: ServerContext,
  campaignId: string,
): Promise<RuleSet> {
  const { rows } = await context.pool.query<{ rule_set: unknown }>(
    'SELECT rule_set FROM campaigns WHERE id = $1',
    [campaignId],
  );
  return mergeRuleSet(rows[0]?.rule_set as never);
}

async function ownsActor(
  context: ServerContext,
  actorId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await context.pool.query(
    'SELECT 1 FROM actor_ownership WHERE actor_id = $1 AND user_id = $2',
    [actorId, userId],
  );
  return rows.length > 0;
}

async function actorIsAssigned(context: ServerContext, actorId: string): Promise<boolean> {
  const { rows } = await context.pool.query(
    'SELECT 1 FROM actor_ownership WHERE actor_id = $1 LIMIT 1',
    [actorId],
  );
  return rows.length > 0;
}

export async function controlLevel(
  context: ServerContext,
  userId: string,
  role: string,
  token: TokenControl,
  rules: RuleSet,
): Promise<ControlLevel> {
  // Il controllo preso vince su tutto il resto: è il caso per cui esiste.
  if (token.controlledByGameMaster) {
    return role === 'game_master' ? 'full' : 'none';
  }
  if (role === 'game_master') {
    if (rules.movement.gameMasterMovesPlayerTokens) return 'full';
    // Solo le pedine davvero affidate a qualcuno gli sfuggono di mano: un
    // mostro resta suo anche con la regola spenta.
    const assigned = token.actorId ? await actorIsAssigned(context, token.actorId) : false;
    return assigned ? 'manage' : 'full';
  }
  if (!token.actorId) return 'none';
  return (await ownsActor(context, token.actorId, userId)) ? 'move' : 'none';
}

/**
 * Se chi guarda vede attraverso questa pedina.
 *
 * Non è la stessa domanda del controllo: un personaggio dominato continua a
 * vedere quello che ha davanti, e chi lo possiede continua a guardare da lì
 * anche mentre è il Game Master a muoverlo. Essere dominati non acceca.
 */
export async function perceivesThrough(
  context: ServerContext,
  userId: string,
  role: string,
  token: TokenControl,
): Promise<boolean> {
  if (role === 'game_master') return true;
  if (!token.actorId) return false;
  return ownsActor(context, token.actorId, userId);
}

/** Campi che chi ha solo il controllo del movimento può toccare. */
const MOVEMENT_FIELDS = new Set(['version', 'x', 'y', 'rotationDeg', 'snapToGrid']);

/** Campi che chi non può muovere la pedina non può toccare. */
const POSITION_FIELDS = new Set(['x', 'y', 'rotationDeg', 'snapToGrid']);

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
  controlled_by_game_master: boolean;
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
    controlledByGameMaster: row.controlled_by_game_master ?? false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

const SELECT_TOKEN = `
  SELECT id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
         color, disposition, hidden, controlled_by_game_master, created_at, updated_at, version
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

/**
 * Se fra due posizioni c'è un muro che ferma il passo.
 *
 * Si guarda il tragitto del centro della pedina: è una semplificazione
 * dichiarata — una creatura larga potrebbe sfiorare uno spigolo — e il Game
 * Master può sempre autorizzare lo spostamento comunque.
 */
async function movementIsBlocked(
  context: ServerContext,
  sceneId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<boolean> {
  const walls = await loadWalls(context, sceneId);
  if (walls.length === 0) return false;
  return !canTraverse(from, to, walls.map(toWallSegment));
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
        // Una pedina legata a un personaggio ne eredita taglia e colore, a meno
        // che non siano stati indicati espressamente: è il personaggio a dire
        // che aspetto ha, non chi lo mette sul tavolo.
        let sizeInCells = input.sizeInCells ?? DEFAULT_TOKEN_SIZE_IN_CELLS;
        let color = input.color ?? DEFAULT_TOKEN_COLOR;
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
          sizeInCells = input.sizeInCells ?? actor.size_in_cells;
          color = input.color ?? actor.color;
        }

        const grid = await gridOf(context, access.sceneId);
        const position = place({ x: input.x, y: input.y }, grid, sizeInCells, input.snapToGrid);

        const { rows } = await context.pool.query<TokenRow>(
          `INSERT INTO tokens (scene_id, actor_id, name, x, y, size_in_cells, color, disposition,
                               hidden, controlled_by_game_master)
           VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8, $10)
           RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
                     color, disposition, hidden, controlled_by_game_master, created_at, updated_at, version`,
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
            input.controlledByGameMaster,
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

        const rules = await campaignRules(context, access.campaignId);
        const control = await controlLevel(context, viewer.id, access.role, {
          actorId: current.actor_id,
          controlledByGameMaster: current.controlled_by_game_master,
        }, rules);
        if (control === 'none') {
          const message = current.controlled_by_game_master
            ? 'Questa pedina è sotto il controllo del Game Master'
            : 'Questa pedina non è sotto il tuo controllo';
          throw new HttpError(403, 'forbidden', message);
        }
        const touched = Object.keys(request.body as Record<string, unknown>);
        if (control === 'move') {
          const forbidden = touched.filter((key) => !MOVEMENT_FIELDS.has(key));
          if (forbidden.length > 0) {
            throw new HttpError(
              403,
              'forbidden',
              'Puoi spostare la pedina, non modificarne le proprietà',
            );
          }
        }
        if (control === 'manage') {
          const forbidden = touched.filter((key) => POSITION_FIELDS.has(key));
          if (forbidden.length > 0) {
            throw new HttpError(
              403,
              'token_movement_reserved',
              'Le regole di questa campagna lasciano il movimento a chi possiede il personaggio. ' +
                'Per muoverla tu, prendine il controllo o cambia la regola.',
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

        // I muri fermano il movimento sul server, non solo nell'interfaccia:
        // un client che li ignorasse verrebbe comunque rifiutato. Il Game
        // Master resta l'autorità finale e passa sempre.
        if (moved && access.role !== 'game_master') {
          const blocked = await movementIsBlocked(
            context,
            access.sceneId,
            { x: current.x, y: current.y },
            position,
          );
          if (blocked) {
            throw new HttpError(
              422,
              'movement_blocked',
              'Il percorso è bloccato da un muro',
              toToken(current),
            );
          }
        }

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
                  controlled_by_game_master = COALESCE($11, controlled_by_game_master),
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg,
                  color, disposition, hidden, controlled_by_game_master,
                  created_at, updated_at, version`,
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
            input.controlledByGameMaster ?? null,
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

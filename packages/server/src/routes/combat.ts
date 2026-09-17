import {
  addCombatantsInputSchema,
  createTerrainInputSchema,
  moveTokenInputSchema,
  startEncounterInputSchema,
  updateInitiativeInputSchema,
  type CampaignRole,
  type Encounter,
  type InitiativeEntry,
  type MoveResult,
  type MovementRecord,
  type TerrainRegion,
  type Token,
} from '@legendforge/contracts';
import {
  availableModes,
  cellCenterToImagePoint,
  fitsInBudget,
  movementBudget,
  planMovement,
  polygonContains,
  snapImagePointToFootprint,
  type CellCoord,
  type GridConfiguration,
  type ImagePoint,
  type MovementProfile,
  type RuleSet,
  type TerrainKind,
} from '@legendforge/core';
import { requireGameMaster, requireSceneAccess, requireTokenAccess } from '../access.js';
import { requireViewer, type ServerContext } from '../context.js';
import { emitSceneEvent, pruneSceneEvents } from '../events.js';
import { HttpError, type Route } from '../http.js';
import { parseBody } from '../validate.js';
import { loadWalls, toWallSegment } from '../vision.js';
import { campaignRules, controlLevel, toToken, type TokenRow } from './tokens.js';
import { loadSceneVisionContext, viewerViewpoints } from './vision.js';

/**
 * Scontri, turni e movimento.
 *
 * Il budget non è un suggerimento per l'interfaccia: il server rifà il conto
 * del percorso e non si fida del costo che arriva dal client. Il Game Master
 * resta l'autorità finale e può autorizzare comunque — ma resta scritto che
 * l'ha fatto.
 */

/* --------------------------------- righe --------------------------------- */

interface EncounterRow {
  id: string;
  scene_id: string;
  round: number;
  status: 'active' | 'ended';
  active_entry_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

interface EntryRow {
  id: string;
  encounter_id: string;
  token_id: string;
  initiative: number;
  tiebreak: number;
  movement_used_meters: number;
  diagonals_used: number;
  movement_mode: string;
  has_acted: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  token_name: string;
  actor_movement: unknown;
}

interface TerrainRow {
  id: string;
  scene_id: string;
  name: string;
  kind: TerrainRegion['kind'];
  points: unknown;
  color: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const SELECT_ENTRIES = `
  SELECT e.id, e.encounter_id, e.token_id, e.initiative, e.tiebreak,
         e.movement_used_meters, e.diagonals_used, e.movement_mode, e.has_acted,
         e.created_at, e.updated_at, e.version,
         t.name AS token_name, a.movement AS actor_movement
    FROM initiative_entries e
    JOIN tokens t ON t.id = e.token_id
    LEFT JOIN actors a ON a.id = t.actor_id`;

const SELECT_TERRAIN = `
  SELECT id, scene_id, name, kind, points, color, created_at, updated_at, version
    FROM terrain_regions`;

/** Velocità di chi si muove, dai dati dell'attore o dal valore di base. */
function profileOf(raw: unknown): MovementProfile {
  if (typeof raw !== 'object' || raw === null) return { camminare: 9 };
  const profile: MovementProfile = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) profile[mode] = value;
  }
  return Object.keys(profile).length > 0 ? profile : { camminare: 9 };
}

function toEntry(row: EntryRow, grid: GridConfiguration): InitiativeEntry {
  const profile = profileOf(row.actor_movement);
  const budget = movementBudget(profile, row.movement_mode, Number(row.movement_used_meters), grid);
  return {
    id: row.id,
    encounterId: row.encounter_id,
    tokenId: row.token_id,
    initiative: Number(row.initiative),
    tiebreak: row.tiebreak,
    movementUsedMeters: Number(row.movement_used_meters),
    diagonalsUsed: row.diagonals_used,
    movementMode: row.movement_mode,
    hasActed: row.has_acted,
    tokenName: row.token_name,
    movementTotalMeters: budget.totalMeters,
    movementRemainingMeters: budget.remainingMeters,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

function toTerrain(row: TerrainRow): TerrainRegion {
  return {
    id: row.id,
    sceneId: row.scene_id,
    name: row.name,
    kind: row.kind,
    points: Array.isArray(row.points) ? (row.points as ImagePoint[]) : [],
    color: row.color,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

/* -------------------------------- caricamento ---------------------------- */

async function loadEncounter(
  context: ServerContext,
  sceneId: string,
  grid: GridConfiguration,
): Promise<Encounter | null> {
  const { rows } = await context.pool.query<EncounterRow>(
    `SELECT id, scene_id, round, status, active_entry_id, created_at, updated_at, version
       FROM encounters WHERE scene_id = $1 AND status = 'active'`,
    [sceneId],
  );
  const row = rows[0];
  if (!row) return null;
  const entries = await context.pool.query<EntryRow>(
    `${SELECT_ENTRIES} WHERE e.encounter_id = $1
      ORDER BY e.initiative DESC, e.tiebreak DESC, e.created_at ASC`,
    [row.id],
  );
  return {
    id: row.id,
    sceneId: row.scene_id,
    round: row.round,
    status: row.status,
    activeEntryId: row.active_entry_id,
    entries: entries.rows.map((entry) => toEntry(entry, grid)),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

async function loadTerrain(context: ServerContext, sceneId: string): Promise<TerrainRegion[]> {
  const { rows } = await context.pool.query<TerrainRow>(
    `${SELECT_TERRAIN} WHERE scene_id = $1 ORDER BY created_at ASC`,
    [sceneId],
  );
  return rows.map(toTerrain);
}

/**
 * Il terreno di una casella.
 *
 * Si guarda il centro della casella: è la stessa semplificazione del resto del
 * movimento, e una pozza che copre mezza casella la copre o non la copre a
 * seconda di dove sta il centro, che è una regola comprensibile al tavolo.
 */
function terrainLookup(
  regions: readonly TerrainRegion[],
  grid: GridConfiguration,
): ((cell: CellCoord) => TerrainKind) | undefined {
  if (regions.length === 0) return undefined;
  return (cell: CellCoord): TerrainKind => {
    const center = cellCenterToImagePoint(cell, grid);
    let found: TerrainKind = 'normal';
    for (const region of regions) {
      if (region.points.length < 3) continue;
      if (!polygonContains(region.points, center)) continue;
      // L'impraticabile vince: se una casella è entrambe le cose, non si passa.
      if (region.kind === 'impassable') return 'impassable';
      found = 'difficult';
    }
    return found;
  };
}

/* ------------------------------ autorizzazioni --------------------------- */

async function requireEncounterAccess(
  context: ServerContext,
  viewer: { id: string },
  encounterId: string,
): Promise<{ encounterId: string; sceneId: string; campaignId: string; role: CampaignRole }> {
  const { rows } = await context.pool.query<{
    scene_id: string;
    campaign_id: string;
    role: CampaignRole;
  }>(
    `SELECT e.scene_id, s.campaign_id, m.role
       FROM encounters e
       JOIN scenes s ON s.id = e.scene_id AND s.deleted_at IS NULL
       JOIN campaign_memberships m
         ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
      WHERE e.id = $1`,
    [encounterId, viewer.id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'Scontro non trovato');
  return { encounterId, sceneId: row.scene_id, campaignId: row.campaign_id, role: row.role };
}

function requireMaster(role: CampaignRole): void {
  if (role !== 'game_master') {
    throw new HttpError(403, 'forbidden', 'Solo il Game Master conduce lo scontro');
  }
}

/**
 * Annuncia che una pedina si è mossa, con la stessa regola di sempre: una
 * pedina nascosta ai giocatori risulta sparita, non spostata.
 */
async function announceMoved(
  context: ServerContext,
  sceneId: string,
  token: Token,
): Promise<void> {
  if (token.hidden) {
    await emitSceneEvent(context.pool, sceneId, 'token.removed', { id: token.id }, 'all');
    await emitSceneEvent(context.pool, sceneId, 'token.upserted', token, 'game_master');
  } else {
    await emitSceneEvent(context.pool, sceneId, 'token.upserted', token, 'all');
  }
  void pruneSceneEvents(context.pool, sceneId);
}

async function announce(context: ServerContext, sceneId: string, kind: 'encounter.changed' | 'terrain.changed'): Promise<void> {
  await emitSceneEvent(context.pool, sceneId, kind, { sceneId }, 'all');
  void pruneSceneEvents(context.pool, sceneId);
}

/** 1d20, come al tavolo. I tiri veri arrivano con Milestone 6. */
function rollD20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

export function combatRoutes(context: ServerContext): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId/encounter',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        const vision = await loadSceneVisionContext(context, access.sceneId);
        const encounter = await loadEncounter(context, access.sceneId, vision.grid);
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: encounter };
      },
    },

    {
      method: 'POST',
      pattern: '/api/scenes/:sceneId/encounter',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireMaster(access.role);
        const input = parseBody(startEncounterInputSchema, request.body);

        const existing = await context.pool.query<{ id: string }>(
          `SELECT id FROM encounters WHERE scene_id = $1 AND status = 'active'`,
          [access.sceneId],
        );
        if (existing.rows[0]) {
          throw new HttpError(409, 'encounter_running', 'Uno scontro è già in corso su questa scena');
        }

        const tokens = await context.pool.query<{ id: string }>(
          input.tokenIds && input.tokenIds.length > 0
            ? `SELECT id FROM tokens WHERE scene_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at`
            : `SELECT id FROM tokens WHERE scene_id = $1 ORDER BY created_at`,
          input.tokenIds && input.tokenIds.length > 0
            ? [access.sceneId, input.tokenIds]
            : [access.sceneId],
        );
        if (tokens.rows.length === 0) {
          throw new HttpError(422, 'invalid_input', 'Non c’è nessuna pedina da mettere in ordine');
        }

        const created = await context.pool.query<{ id: string }>(
          `INSERT INTO encounters (scene_id) VALUES ($1) RETURNING id`,
          [access.sceneId],
        );
        const encounterId = created.rows[0]?.id;
        if (!encounterId) throw new Error('scontro non creato');

        for (const [index, token] of tokens.rows.entries()) {
          await context.pool.query(
            `INSERT INTO initiative_entries (encounter_id, token_id, initiative, tiebreak)
             VALUES ($1, $2, $3, $4)`,
            [encounterId, token.id, input.rollInitiative ? rollD20() : 0, tokens.rows.length - index],
          );
        }

        // Il turno va a chi ha l'iniziativa più alta.
        await context.pool.query(
          `UPDATE encounters SET active_entry_id = (
             SELECT id FROM initiative_entries WHERE encounter_id = $1
              ORDER BY initiative DESC, tiebreak DESC, created_at ASC LIMIT 1)
           WHERE id = $1`,
          [encounterId],
        );

        await announce(context, access.sceneId, 'encounter.changed');
        const vision = await loadSceneVisionContext(context, access.sceneId);
        return { status: 201, body: await loadEncounter(context, access.sceneId, vision.grid) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/encounters/:encounterId/combatants',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireEncounterAccess(context, viewer, params.encounterId ?? '');
        requireMaster(access.role);
        const input = parseBody(addCombatantsInputSchema, request.body);

        for (const tokenId of input.tokenIds) {
          const belongs = await context.pool.query(
            'SELECT 1 FROM tokens WHERE id = $1 AND scene_id = $2',
            [tokenId, access.sceneId],
          );
          if (belongs.rows.length === 0) continue;
          await context.pool.query(
            `INSERT INTO initiative_entries (encounter_id, token_id, initiative)
             VALUES ($1, $2, $3) ON CONFLICT (encounter_id, token_id) DO NOTHING`,
            [access.encounterId, tokenId, input.rollInitiative ? rollD20() : 0],
          );
        }
        await announce(context, access.sceneId, 'encounter.changed');
        const vision = await loadSceneVisionContext(context, access.sceneId);
        return { status: 200, body: await loadEncounter(context, access.sceneId, vision.grid) };
      },
    },

    {
      /**
       * Passa il turno.
       *
       * Alla fine del giro si comincia un round nuovo e il movimento speso si
       * azzera: è il momento in cui tutti ricominciano a camminare.
       */
      method: 'POST',
      pattern: '/api/encounters/:encounterId/next',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireEncounterAccess(context, viewer, params.encounterId ?? '');
        requireMaster(access.role);

        const order = await context.pool.query<{ id: string }>(
          `SELECT id FROM initiative_entries WHERE encounter_id = $1
            ORDER BY initiative DESC, tiebreak DESC, created_at ASC`,
          [access.encounterId],
        );
        if (order.rows.length === 0) {
          throw new HttpError(422, 'invalid_input', 'Nessuno in ordine di iniziativa');
        }
        const current = await context.pool.query<{ active_entry_id: string | null; round: number }>(
          'SELECT active_entry_id, round FROM encounters WHERE id = $1',
          [access.encounterId],
        );
        const activeId = current.rows[0]?.active_entry_id ?? null;
        const index = order.rows.findIndex((row) => row.id === activeId);
        const nextIndex = index === -1 ? 0 : (index + 1) % order.rows.length;
        const wrapped = index !== -1 && nextIndex === 0;
        const nextId = order.rows[nextIndex]?.id ?? null;

        await context.pool.query(
          `UPDATE encounters
              SET active_entry_id = $2,
                  round = round + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
                  updated_at = now(), version = version + 1
            WHERE id = $1`,
          [access.encounterId, nextId, wrapped],
        );
        // Il movimento di chi entra in turno riparte da zero.
        await context.pool.query(
          `UPDATE initiative_entries
              SET movement_used_meters = 0, diagonals_used = 0, has_acted = false,
                  updated_at = now(), version = version + 1
            WHERE id = $1`,
          [nextId],
        );

        await announce(context, access.sceneId, 'encounter.changed');
        const vision = await loadSceneVisionContext(context, access.sceneId);
        return { status: 200, body: await loadEncounter(context, access.sceneId, vision.grid) };
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/initiative/:entryId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const entryId = params.entryId ?? '';
        const owner = await context.pool.query<{ encounter_id: string }>(
          'SELECT encounter_id FROM initiative_entries WHERE id = $1',
          [entryId],
        );
        const encounterId = owner.rows[0]?.encounter_id;
        if (!encounterId) throw new HttpError(404, 'not_found', 'Voce non trovata');
        const access = await requireEncounterAccess(context, viewer, encounterId);
        requireMaster(access.role);
        const input = parseBody(updateInitiativeInputSchema, request.body);

        const { rows } = await context.pool.query<{ id: string }>(
          `UPDATE initiative_entries
              SET initiative    = COALESCE($3, initiative),
                  movement_mode = COALESCE($4, movement_mode),
                  has_acted     = COALESCE($5, has_acted),
                  movement_used_meters = CASE WHEN $6::boolean THEN 0 ELSE movement_used_meters END,
                  diagonals_used = CASE WHEN $6::boolean THEN 0 ELSE diagonals_used END,
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id`,
          [
            entryId,
            input.version,
            input.initiative ?? null,
            input.movementMode ?? null,
            input.hasActed ?? null,
            input.resetMovement ?? false,
          ],
        );
        if (rows.length === 0) {
          throw new HttpError(409, 'version_conflict', 'La voce è stata modificata altrove');
        }
        await announce(context, access.sceneId, 'encounter.changed');
        const vision = await loadSceneVisionContext(context, access.sceneId);
        return { status: 200, body: await loadEncounter(context, access.sceneId, vision.grid) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/encounters/:encounterId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireEncounterAccess(context, viewer, params.encounterId ?? '');
        requireMaster(access.role);
        await context.pool.query(
          `UPDATE encounters SET status = 'ended', ended_at = now(), active_entry_id = NULL,
                  updated_at = now(), version = version + 1
            WHERE id = $1`,
          [access.encounterId],
        );
        await announce(context, access.sceneId, 'encounter.changed');
        return { status: 200, body: { ok: true } };
      },
    },

    /* ------------------------------ spostamento ---------------------------- */

    {
      /**
       * Sposta una pedina lungo un percorso.
       *
       * Il server rifà il conto: i waypoint arrivano dal client, il costo no.
       * Un percorso che sbatte contro un muro non viene rifiutato — si ferma
       * dove sbatte, e la pedina arriva lì. Il budget si consuma solo quando
       * c'è uno scontro in corso: fuori dal combattimento ci si muove e basta.
       */
      method: 'POST',
      pattern: '/api/tokens/:tokenId/move',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireTokenAccess(context, viewer, params.tokenId ?? '');
        const input = parseBody(moveTokenInputSchema, request.body);

        const tokenRows = await context.pool.query<TokenRow>(
          `SELECT id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg, color,
                  disposition, hidden, controlled_by_game_master, created_at, updated_at, version
             FROM tokens WHERE id = $1`,
          [access.tokenId],
        );
        const current = tokenRows.rows[0];
        if (!current) throw new HttpError(404, 'not_found', 'Pedina non trovata');

        const rules: RuleSet = await campaignRules(context, access.campaignId);
        const control = await controlLevel(context, viewer.id, access.role, {
          actorId: current.actor_id,
          controlledByGameMaster: current.controlled_by_game_master,
        }, rules);
        if (control !== 'full' && control !== 'move') {
          throw new HttpError(403, 'forbidden', 'Non puoi muovere questa pedina');
        }

        const vision = await loadSceneVisionContext(context, access.sceneId);
        const grid = vision.grid;
        const walls = (await loadWalls(context, access.sceneId)).map(toWallSegment);
        const regions = await loadTerrain(context, access.sceneId);
        const encounter = await loadEncounter(context, access.sceneId, grid);
        const entry = encounter?.entries.find((candidate) => candidate.tokenId === current.id) ?? null;

        const actorMovement = await context.pool.query<{ movement: unknown }>(
          'SELECT movement FROM actors WHERE id = $1',
          [current.actor_id],
        );
        const profile = profileOf(actorMovement.rows[0]?.movement);
        const mode =
          input.mode ?? entry?.movementMode ?? availableModes(profile)[0] ?? 'camminare';

        // Il percorso parte sempre da dove la pedina è adesso, non da dove il
        // client crede che sia.
        const waypoints: ImagePoint[] = [{ x: Number(current.x), y: Number(current.y) }];
        for (const point of input.waypoints) waypoints.push(point);

        const terrainAt = terrainLookup(regions, grid);
        const plan = planMovement(waypoints, {
          grid,
          diagonalRule: rules.movement.diagonalRule,
          difficultTerrainMultiplier: rules.movement.difficultTerrainMultiplier,
          mode,
          walls,
          diagonalsSoFar: entry?.diagonalsUsed ?? 0,
          ...(terrainAt ? { terrainAt } : {}),
        });

        if (!plan.destination) {
          throw new HttpError(422, 'invalid_input', 'Il percorso non porta da nessuna parte');
        }

        let overridden = false;
        if (entry && rules.movement.enforceBudget) {
          const budget = movementBudget(profile, mode, entry.movementUsedMeters, grid);
          const verdict = fitsInBudget(budget, plan.costInMeters);
          if (!verdict.allowed) {
            const mayOverride =
              access.role === 'game_master' &&
              input.overrideBudget &&
              rules.movement.allowGameMasterOverride;
            if (!mayOverride) {
              throw new HttpError(
                422,
                'movement_budget_exceeded',
                verdict.reason === 'senza_movimento'
                  ? `Questa creatura non si muove in modalità ${mode}`
                  : `Mancano ${verdict.shortfallMeters.toFixed(1)} m di movimento`,
                {
                  costMeters: plan.costInMeters,
                  remainingMeters: budget.remainingMeters,
                  totalMeters: budget.totalMeters,
                  shortfallMeters: verdict.shortfallMeters,
                },
              );
            }
            overridden = true;
          }
        }

        const sizeInCells = Number(current.size_in_cells);
        const landing = input.snapToGrid
          ? snapImagePointToFootprint(plan.destination, grid, sizeInCells)
          : plan.destination;

        const updated = await context.pool.query<TokenRow>(
          `UPDATE tokens SET x = $3, y = $4, updated_at = now(), version = version + 1
            WHERE id = $1 AND version = $2
        RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg, color,
                  disposition, hidden, controlled_by_game_master, created_at, updated_at, version`,
          [current.id, input.version, landing.x, landing.y],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new HttpError(409, 'version_conflict', 'La pedina è stata spostata altrove', toToken(current));
        }

        let movementId: number | null = null;
        if (entry) {
          await context.pool.query(
            `UPDATE initiative_entries
                SET movement_used_meters = movement_used_meters + $2,
                    diagonals_used = diagonals_used + $3,
                    movement_mode = $4,
                    updated_at = now(), version = version + 1
              WHERE id = $1`,
            [entry.id, plan.costInMeters, plan.diagonals, mode],
          );
        }
        const logged = await context.pool.query<{ id: string }>(
          `INSERT INTO movement_log
             (encounter_id, entry_id, token_id, round, from_x, from_y, to_x, to_y,
              cost_meters, diagonals, mode, waypoints, overridden)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
           RETURNING id`,
          [
            encounter?.id ?? null,
            entry?.id ?? null,
            current.id,
            encounter?.round ?? 1,
            Number(current.x),
            Number(current.y),
            landing.x,
            landing.y,
            plan.costInMeters,
            plan.diagonals,
            mode,
            JSON.stringify(input.waypoints),
            overridden,
          ],
        );
        movementId = logged.rows[0] ? Number(logged.rows[0].id) : null;

        const token = toToken(row);
        await announceMoved(context, access.sceneId, token);
        if (entry) await announce(context, access.sceneId, 'encounter.changed');

        const after = entry
          ? movementBudget(profile, mode, entry.movementUsedMeters + plan.costInMeters, grid)
          : null;
        const body: MoveResult = {
          token,
          costMeters: plan.costInMeters,
          stoppedBy: plan.reason,
          remainingMeters: after ? after.remainingMeters : null,
          totalMeters: after ? after.totalMeters : null,
          overridden,
          movementId,
        };
        return { status: 200, body };
      },
    },

    {
      method: 'GET',
      pattern: '/api/encounters/:encounterId/history',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireEncounterAccess(context, viewer, params.encounterId ?? '');
        const { rows } = await context.pool.query<{
          id: string;
          token_id: string;
          token_name: string;
          round: number;
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          cost_meters: number;
          mode: string;
          overridden: boolean;
          undone_at: Date | string | null;
          created_at: Date | string;
        }>(
          `SELECT l.id, l.token_id, t.name AS token_name, l.round, l.from_x, l.from_y,
                  l.to_x, l.to_y, l.cost_meters, l.mode, l.overridden, l.undone_at, l.created_at
             FROM movement_log l JOIN tokens t ON t.id = l.token_id
            WHERE l.encounter_id = $1
            ORDER BY l.id DESC LIMIT 200`,
          [access.encounterId],
        );
        const body: MovementRecord[] = rows.map((row) => ({
          id: Number(row.id),
          tokenId: row.token_id,
          tokenName: row.token_name,
          round: row.round,
          from: { x: Number(row.from_x), y: Number(row.from_y) },
          to: { x: Number(row.to_x), y: Number(row.to_y) },
          costMeters: Number(row.cost_meters),
          mode: row.mode,
          overridden: row.overridden,
          undone: row.undone_at !== null,
          at: toIso(row.created_at),
        }));
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body };
      },
    },

    {
      /**
       * Annulla uno spostamento.
       *
       * La pedina torna dov'era e il movimento speso viene restituito. Non si
       * cancella la riga: resta segnata come annullata, perché a fine serata
       * la domanda è «che cosa è successo», non «che cosa è rimasto».
       */
      method: 'POST',
      pattern: '/api/movements/:movementId/undo',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const movementId = Number.parseInt(params.movementId ?? '', 10);
        if (!Number.isFinite(movementId)) {
          throw new HttpError(404, 'not_found', 'Spostamento non trovato');
        }
        const { rows } = await context.pool.query<{
          token_id: string;
          entry_id: string | null;
          scene_id: string;
          campaign_id: string;
          role: CampaignRole;
          from_x: number;
          from_y: number;
          cost_meters: number;
          diagonals: number;
          undone_at: Date | string | null;
          actor_id: string | null;
          controlled_by_game_master: boolean;
        }>(
          `SELECT l.token_id, l.entry_id, t.scene_id, s.campaign_id, m.role,
                  l.from_x, l.from_y, l.cost_meters, l.diagonals, l.undone_at,
                  t.actor_id, t.controlled_by_game_master
             FROM movement_log l
             JOIN tokens t ON t.id = l.token_id
             JOIN scenes s ON s.id = t.scene_id AND s.deleted_at IS NULL
             JOIN campaign_memberships m
               ON m.campaign_id = s.campaign_id AND m.user_id = $2 AND m.status = 'active'
            WHERE l.id = $1`,
          [movementId, viewer.id],
        );
        const record = rows[0];
        if (!record) throw new HttpError(404, 'not_found', 'Spostamento non trovato');
        if (record.undone_at !== null) {
          throw new HttpError(409, 'already_undone', 'Questo spostamento era già stato annullato');
        }

        const rules: RuleSet = await campaignRules(context, record.campaign_id);
        const control = await controlLevel(context, viewer.id, record.role, {
          actorId: record.actor_id,
          controlledByGameMaster: record.controlled_by_game_master,
        }, rules);
        if (control !== 'full' && control !== 'move') {
          throw new HttpError(403, 'forbidden', 'Non puoi annullare questo spostamento');
        }

        const moved = await context.pool.query<TokenRow>(
          `UPDATE tokens SET x = $2, y = $3, updated_at = now(), version = version + 1
            WHERE id = $1
        RETURNING id, scene_id, actor_id, name, x, y, size_in_cells, rotation_deg, color,
                  disposition, hidden, controlled_by_game_master, created_at, updated_at, version`,
          [record.token_id, Number(record.from_x), Number(record.from_y)],
        );
        const row = moved.rows[0];
        if (!row) throw new Error('pedina non riportata indietro');

        if (record.entry_id) {
          await context.pool.query(
            `UPDATE initiative_entries
                SET movement_used_meters = GREATEST(0, movement_used_meters - $2),
                    diagonals_used = GREATEST(0, diagonals_used - $3),
                    updated_at = now(), version = version + 1
              WHERE id = $1`,
            [record.entry_id, Number(record.cost_meters), record.diagonals],
          );
        }
        await context.pool.query('UPDATE movement_log SET undone_at = now() WHERE id = $1', [
          movementId,
        ]);

        const token = toToken(row);
        await announceMoved(context, record.scene_id, token);
        await announce(context, record.scene_id, 'encounter.changed');
        return { status: 200, body: token };
      },
    },

    /* -------------------------------- terreno ------------------------------ */

    {
      method: 'GET',
      pattern: '/api/scenes/:sceneId/terrain',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        const regions = await loadTerrain(context, access.sceneId);
        if (access.role === 'game_master') {
          return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: regions };
        }

        // Al giocatore arrivano solo le zone che ha davanti agli occhi. Una
        // pozza di fango è visibile quanto la stanza in cui sta: mandarle
        // tutte racconterebbe la pianta della mappa, come farebbero i muri.
        const vision = await loadSceneVisionContext(context, access.sceneId);
        if (!vision.settings.visionEnabled) {
          return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: regions };
        }
        const { viewpoints } = await viewerViewpoints(
          context,
          access.sceneId,
          viewer.id,
          access.role,
        );
        const visible = regions.filter((region) =>
          region.points.some((point) =>
            viewpoints.some(
              (viewpoint) =>
                viewpoint.polygon.length >= 3 && polygonContains(viewpoint.polygon, point),
            ),
          ),
        );
        return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: visible };
      },
    },

    {
      method: 'POST',
      pattern: '/api/scenes/:sceneId/terrain',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const access = await requireSceneAccess(context, viewer, params.sceneId ?? '');
        requireGameMaster(access);
        const input = parseBody(createTerrainInputSchema, request.body);
        const { rows } = await context.pool.query<TerrainRow>(
          `INSERT INTO terrain_regions (scene_id, name, kind, points, color)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           RETURNING id, scene_id, name, kind, points, color, created_at, updated_at, version`,
          [access.sceneId, input.name, input.kind, JSON.stringify(input.points), input.color],
        );
        const row = rows[0];
        if (!row) throw new Error('zona non creata');
        await announce(context, access.sceneId, 'terrain.changed');
        return { status: 201, body: toTerrain(row) };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/terrain/:regionId',
      async handle({ request, params }) {
        const viewer = await requireViewer(context, request);
        const regionId = params.regionId ?? '';
        const owner = await context.pool.query<{ scene_id: string }>(
          'SELECT scene_id FROM terrain_regions WHERE id = $1',
          [regionId],
        );
        const sceneId = owner.rows[0]?.scene_id;
        if (!sceneId) throw new HttpError(404, 'not_found', 'Zona non trovata');
        const access = await requireSceneAccess(context, viewer, sceneId);
        requireGameMaster(access);
        await context.pool.query('DELETE FROM terrain_regions WHERE id = $1', [regionId]);
        await announce(context, sceneId, 'terrain.changed');
        return { status: 200, body: { ok: true } };
      },
    },
  ];
}

export { loadEncounter, loadTerrain, profileOf, terrainLookup, SELECT_ENTRIES };
export type { EntryRow };

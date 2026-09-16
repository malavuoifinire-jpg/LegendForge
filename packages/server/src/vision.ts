import type {
  LightSource,
  SceneVisionSettings,
  Token,
  Viewpoint,
  Wall,
} from '@legendforge/contracts';
import {
  computeVisibilityPolygon,
  hasLineOfSight,
  DEFAULT_VISION_PROFILE,
  metersToPixels,
  pixelsPerMeter,
  polygonContains,
  sightRadiusWithLights,
  type GridConfiguration,
  type LightSourceShape,
  type VisionProfile,
  type WallSegment,
} from '@legendforge/core';
import type { ServerContext } from './context.js';

/**
 * Visione lato server.
 *
 * Questo è il modulo che decide che cosa una persona può vedere. Al client non
 * arrivano mai i muri: arriva il poligono già calcolato, quindi dalla risposta
 * non si può ricostruire la pianta di una mappa mai esplorata. Lo stesso
 * calcolo filtra le pedine, cosicché una sola funzione risponde alla domanda
 * "questo lo posso sapere?".
 */

export interface WallRow {
  id: string;
  scene_id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: Wall['kind'];
  door_state: Wall['doorState'];
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export interface LightRow {
  id: string;
  scene_id: string;
  token_id: string | null;
  name: string;
  x: number;
  y: number;
  bright_radius_meters: number;
  dim_radius_meters: number;
  color: string;
  enabled: boolean;
  remaining_minutes: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toWall(row: WallRow): Wall {
  return {
    id: row.id,
    sceneId: row.scene_id,
    ax: Number(row.ax),
    ay: Number(row.ay),
    bx: Number(row.bx),
    by: Number(row.by),
    kind: row.kind,
    doorState: row.door_state,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toLight(row: LightRow): LightSource {
  return {
    id: row.id,
    sceneId: row.scene_id,
    tokenId: row.token_id,
    name: row.name,
    x: Number(row.x),
    y: Number(row.y),
    brightRadiusMeters: Number(row.bright_radius_meters),
    dimRadiusMeters: Number(row.dim_radius_meters),
    color: row.color,
    enabled: row.enabled,
    remainingMinutes: row.remaining_minutes === null ? null : Number(row.remaining_minutes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export const SELECT_WALLS = `
  SELECT id, scene_id, ax, ay, bx, by, kind, door_state, created_at, updated_at, version
    FROM scene_walls`;

export const SELECT_LIGHTS = `
  SELECT id, scene_id, token_id, name, x, y, bright_radius_meters, dim_radius_meters,
         color, enabled, remaining_minutes, created_at, updated_at, version
    FROM scene_lights`;

export async function loadWalls(context: ServerContext, sceneId: string): Promise<Wall[]> {
  const { rows } = await context.pool.query<WallRow>(
    `${SELECT_WALLS} WHERE scene_id = $1 ORDER BY created_at ASC`,
    [sceneId],
  );
  return rows.map(toWall);
}

export async function loadLights(context: ServerContext, sceneId: string): Promise<LightSource[]> {
  const { rows } = await context.pool.query<LightRow>(
    `${SELECT_LIGHTS} WHERE scene_id = $1 ORDER BY created_at ASC`,
    [sceneId],
  );
  return rows.map(toLight);
}

/** Un muro del dominio, pronto per la geometria di @legendforge/core. */
export function toWallSegment(wall: Wall): WallSegment {
  return {
    id: wall.id,
    ax: wall.ax,
    ay: wall.ay,
    bx: wall.bx,
    by: wall.by,
    kind: wall.kind,
    doorState: wall.doorState,
  };
}

export interface ActorVisionRow {
  actor_id: string;
  darkvision_meters: number;
  normal_vision_meters: number | null;
  special_senses: unknown;
}

/**
 * Profili sensoriali dei personaggi rappresentati dalle pedine di una scena.
 *
 * Una pedina senza personaggio non ha sensi propri: userà quelli di base della
 * scena, cioè vista normale fin dove arriva la scena e niente scurovisione.
 */
export async function loadVisionProfiles(
  context: ServerContext,
  sceneId: string,
): Promise<Map<string, VisionProfile>> {
  const { rows } = await context.pool.query<ActorVisionRow>(
    `SELECT a.id AS actor_id, a.darkvision_meters, a.normal_vision_meters, a.special_senses
       FROM actors a
      WHERE a.id IN (SELECT actor_id FROM tokens WHERE scene_id = $1 AND actor_id IS NOT NULL)`,
    [sceneId],
  );
  const profiles = new Map<string, VisionProfile>();
  for (const row of rows) {
    profiles.set(row.actor_id, {
      normalRangeMeters:
        row.normal_vision_meters === null ? null : Number(row.normal_vision_meters),
      darkvisionMeters: Number(row.darkvision_meters),
      specialSenses: parseSpecialSenses(row.special_senses),
      elevationMeters: 0,
    });
  }
  return profiles;
}

function parseSpecialSenses(value: unknown): VisionProfile['specialSenses'] {
  if (!Array.isArray(value)) return [];
  const senses: VisionProfile['specialSenses'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : null;
    const range = typeof record.rangeMeters === 'number' ? record.rangeMeters : null;
    if (name && range !== null && Number.isFinite(range) && range >= 0) {
      senses.push({ name, rangeMeters: range });
    }
  }
  return senses;
}

export interface ViewpointInput {
  settings: SceneVisionSettings;
  grid: GridConfiguration;
  walls: readonly Wall[];
  lights: readonly LightSource[];
  tokens: readonly Token[];
  profiles: Map<string, VisionProfile>;
}

/**
 * Da dove si guarda e fin dove si vede, per ciascuna pedina indicata.
 *
 * Le luci agganciate a una pedina si muovono con lei: la posizione da usare è
 * quella della pedina, non quella salvata nella riga della luce.
 */
export function computeViewpoints(input: ViewpointInput, forTokens: readonly Token[]): Viewpoint[] {
  const segments = input.walls.map(toWallSegment);
  const perMeter = pixelsPerMeter(input.grid);
  const tokenById = new Map(input.tokens.map((token) => [token.id, token]));

  const shapes: LightSourceShape[] = [];
  for (const light of input.lights) {
    if (!light.enabled) continue;
    if (light.remainingMinutes !== null && light.remainingMinutes <= 0) continue;
    const carrier = light.tokenId ? tokenById.get(light.tokenId) : undefined;
    shapes.push({
      x: carrier ? carrier.x : light.x,
      y: carrier ? carrier.y : light.y,
      brightRadiusMeters: light.brightRadiusMeters,
      dimRadiusMeters: light.dimRadiusMeters,
    });
  }

  const viewpoints: Viewpoint[] = [];
  for (const token of forTokens) {
    const profile = token.actorId
      ? (input.profiles.get(token.actorId) ?? DEFAULT_VISION_PROFILE)
      : DEFAULT_VISION_PROFILE;
    const origin = { x: token.x, y: token.y };
    const reach = sightRadiusWithLights(profile, origin, shapes, {
      darkness: input.settings.ambientDarkness,
      sceneReachMeters: input.settings.sceneReachMeters,
      pixelsPerMeter: perMeter,
    });
    const radiusPx = metersToPixels(reach.meters, input.grid);
    viewpoints.push({
      tokenId: token.id,
      origin,
      radiusPx,
      radiusMeters: reach.meters,
      source: reach.source,
      polygon:
        radiusPx <= 0 ? [] : computeVisibilityPolygon(origin, segments, { radiusPx }),
    });
  }
  return viewpoints;
}

/** Quanti punti del contorno di una pedina si provano prima di dirla invisibile. */
const PERIMETER_SAMPLES = 8;

/**
 * Se una pedina cade dentro almeno uno dei poligoni.
 *
 * Non basta il centro: una creatura grande che sporge da dietro un angolo si
 * vede, e chi guarda se lo aspetta.
 */
export function tokenIsVisible(
  viewpoints: readonly Viewpoint[],
  token: Token,
  grid: GridConfiguration,
): boolean {
  const probes = [{ x: token.x, y: token.y }];
  const radius = (token.sizeInCells * grid.cellSizePx) / 2;
  if (radius > 0) {
    for (let i = 0; i < PERIMETER_SAMPLES; i += 1) {
      const angle = (i / PERIMETER_SAMPLES) * Math.PI * 2;
      probes.push({
        x: token.x + Math.cos(angle) * radius,
        y: token.y + Math.sin(angle) * radius,
      });
    }
  }
  for (const viewpoint of viewpoints) {
    if (viewpoint.polygon.length < 3) continue;
    for (const probe of probes) {
      if (polygonContains(viewpoint.polygon, probe)) return true;
    }
  }
  return false;
}

/**
 * Le porte che chi guarda ha davanti agli occhi.
 *
 * Il controllo non è "il punto cade nel poligono": gli estremi di una porta
 * stanno esattamente sul bordo del poligono, dove l'appartenenza è ambigua. Si
 * chiede invece se da lì la si vede, che è la stessa domanda posta bene.
 */
export function doorsInSight(
  viewpoints: readonly Viewpoint[],
  walls: readonly Wall[],
): Wall[] {
  const doors = walls.filter((wall) => wall.kind === 'door');
  if (doors.length === 0 || viewpoints.length === 0) return [];
  const segments = walls.map(toWallSegment);

  return doors.filter((door) => {
    const probes = [
      { x: door.ax, y: door.ay },
      { x: door.bx, y: door.by },
      { x: (door.ax + door.bx) / 2, y: (door.ay + door.by) / 2 },
    ];
    return viewpoints.some((viewpoint) =>
      probes.some(
        (probe) =>
          Math.hypot(probe.x - viewpoint.origin.x, probe.y - viewpoint.origin.y) <=
            viewpoint.radiusPx && hasLineOfSight(viewpoint.origin, probe, segments),
      ),
    );
  });
}

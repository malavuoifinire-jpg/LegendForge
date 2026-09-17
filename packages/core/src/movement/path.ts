import {
  cellCenterToImagePoint,
  imagePointToCell,
  pixelsToMeters,
  type GridConfiguration,
} from '../coordinates/grid.js';
import { lineCells, pathCostInCells, type TerrainKind } from '../coordinates/distance.js';
import type { CellCoord, ImagePoint } from '../coordinates/types.js';
import { canTraverse, type WallSegment } from '../vision/index.js';
import type { DiagonalRule } from '../rules/ruleset.js';
import { behaviourOf } from './modes.js';

/**
 * Il percorso di una pedina, da una sequenza di waypoint.
 *
 * Fra un waypoint e il successivo si va in linea retta, casella per casella;
 * il costo si accumula passo dopo passo, così chi trascina vede il numero
 * salire mentre si muove invece di scoprirlo alla fine.
 *
 * Un percorso che sbatte contro un muro non viene rifiutato: viene
 * interrotto. Si dice dove si è fermato e perché, e chi sta giocando decide
 * se accorciare o passare da un'altra parte.
 */

export interface MovementPlanOptions {
  grid: GridConfiguration;
  diagonalRule: DiagonalRule;
  difficultTerrainMultiplier: number;
  /** Modo di movimento: decide che cosa si ignora. */
  mode?: string;
  walls?: readonly WallSegment[];
  terrainAt?: (cell: CellCoord) => TerrainKind;
  /** Diagonali già percorse in questo turno, per la regola a costo alternato. */
  diagonalsSoFar?: number;
}

export interface MovementPlan {
  /** Caselle attraversate, dalla partenza all'arrivo raggiungibile. */
  cells: CellCoord[];
  /** Centri delle caselle, per disegnare la scia. */
  points: ImagePoint[];
  costInCells: number;
  costInMeters: number;
  /** Costo cumulato a ogni casella, per l'etichetta che segue il dito. */
  cumulativeMeters: number[];
  diagonals: number;
  /** Indice della casella in cui il percorso si interrompe, se si interrompe. */
  stoppedAt: number | null;
  reason: 'muro' | 'terreno' | null;
  /** Arrivo davvero raggiunto, che può non essere l'ultimo waypoint. */
  destination: ImagePoint | null;
}

const EMPTY: MovementPlan = {
  cells: [],
  points: [],
  costInCells: 0,
  costInMeters: 0,
  cumulativeMeters: [],
  diagonals: 0,
  stoppedAt: null,
  reason: null,
  destination: null,
};

/** Le caselle toccate da una spezzata di waypoint, senza ripetere i giunti. */
export function cellsThroughWaypoints(
  waypoints: readonly ImagePoint[],
  grid: GridConfiguration,
): CellCoord[] {
  const corners = waypoints.map((point) => imagePointToCell(point, grid));
  const cells: CellCoord[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const from = corners[i];
    const to = corners[i + 1];
    if (!from) continue;
    if (!to) {
      if (cells.length === 0) cells.push(from);
      continue;
    }
    const leg = lineCells(from, to);
    for (const cell of leg) {
      const last = cells[cells.length - 1];
      if (last && last.col === cell.col && last.row === cell.row) continue;
      cells.push(cell);
    }
  }
  return cells;
}

export function planMovement(
  waypoints: readonly ImagePoint[],
  options: MovementPlanOptions,
): MovementPlan {
  if (waypoints.length === 0) return EMPTY;
  const { grid } = options;
  const behaviour = behaviourOf(options.mode);
  const cells = cellsThroughWaypoints(waypoints, grid);
  if (cells.length === 0) return EMPTY;

  const centers = cells.map((cell) => cellCenterToImagePoint(cell, grid));

  // I muri si guardano fra un centro e il successivo. È la stessa
  // semplificazione dichiarata del movimento libero: conta il tragitto del
  // centro della pedina, non il suo ingombro.
  //
  // Conseguenza da sapere: un muro disegnato esattamente sulla linea dei
  // centri non ferma nessuno, perché il tragitto lo sfiora senza tagliarlo.
  // Con l'aggancio alla griglia non può succedere — i vertici cadono sugli
  // angoli delle caselle, i centri stanno a metà — e a mano lo si vede.
  let stoppedAt: number | null = null;
  let reason: MovementPlan['reason'] = null;
  const walls = behaviour.ignoresWalls ? [] : (options.walls ?? []);
  if (walls.length > 0) {
    for (let i = 1; i < centers.length; i += 1) {
      const from = centers[i - 1];
      const to = centers[i];
      if (!from || !to) continue;
      if (!canTraverse(from, to, walls)) {
        stoppedAt = i;
        reason = 'muro';
        break;
      }
    }
  }

  const terrainAt = behaviour.ignoresDifficultTerrain
    ? (cell: CellCoord): TerrainKind => {
        // Volando il terreno difficile non rallenta, ma l'impraticabile
        // resta tale: un muro di forza non si sorvola.
        const kind = options.terrainAt?.(cell) ?? 'normal';
        return kind === 'impassable' ? 'impassable' : 'normal';
      }
    : options.terrainAt;

  const walkable = stoppedAt === null ? cells : cells.slice(0, stoppedAt);
  const cost = pathCostInCells(walkable, {
    diagonalRule: options.diagonalRule,
    difficultTerrainMultiplier: options.difficultTerrainMultiplier,
    diagonalsSoFar: options.diagonalsSoFar ?? 0,
    ...(terrainAt ? { terrainAt } : {}),
  });

  if (cost.blocked && stoppedAt === null) {
    // Una casella impraticabile ferma il percorso lì, come un muro.
    const index = walkable.findIndex(
      (cell) => (terrainAt?.(cell) ?? 'normal') === 'impassable',
    );
    if (index > 0) {
      stoppedAt = index;
      reason = 'terreno';
    }
  }

  const reached = stoppedAt === null ? walkable : walkable.slice(0, stoppedAt);
  const finalCost =
    stoppedAt === null
      ? cost
      : pathCostInCells(reached, {
          diagonalRule: options.diagonalRule,
          difficultTerrainMultiplier: options.difficultTerrainMultiplier,
          diagonalsSoFar: options.diagonalsSoFar ?? 0,
          ...(terrainAt ? { terrainAt } : {}),
        });

  const metersPerCell = grid.metersPerCell;
  const points = reached.map((cell) => cellCenterToImagePoint(cell, grid));
  return {
    cells: reached,
    points,
    costInCells: finalCost.cells,
    costInMeters: finalCost.cells * metersPerCell,
    cumulativeMeters: finalCost.cumulative.map((value) => value * metersPerCell),
    diagonals: finalCost.diagonals,
    stoppedAt,
    reason,
    destination: points[points.length - 1] ?? null,
  };
}

/** Distanza in metri fra due punti immagine, senza passare dalle caselle. */
export function straightMeters(
  from: ImagePoint,
  to: ImagePoint,
  grid: GridConfiguration,
): number {
  return pixelsToMeters(Math.hypot(to.x - from.x, to.y - from.y), grid);
}

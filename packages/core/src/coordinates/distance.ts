import type { DiagonalRule } from '../rules/ruleset.js';
import type { CellCoord } from './types.js';

/** Terreno di una casella ai fini del costo di movimento. */
export type TerrainKind = 'normal' | 'difficult' | 'impassable';

export interface StepCostOptions {
  diagonalRule: DiagonalRule;
  difficultTerrainMultiplier: number;
  /** Diagonali già percorse, per la regola a costo alternato. */
  diagonalsSoFar?: number;
}

export interface StepCostResult {
  /** Costo del passo in caselle. */
  cells: number;
  /** Diagonali percorse dopo questo passo. */
  diagonalsSoFar: number;
}

/**
 * Costo in caselle di un passo fra due caselle. Passi non adiacenti sono
 * valutati come spostamento in linea retta con la stessa regola diagonale.
 */
export function stepCostInCells(
  from: CellCoord,
  to: CellCoord,
  options: StepCostOptions,
): StepCostResult {
  const dx = Math.abs(to.col - from.col);
  const dy = Math.abs(to.row - from.row);
  const straight = Math.abs(dx - dy);
  const diagonals = Math.min(dx, dy);
  const previousDiagonals = options.diagonalsSoFar ?? 0;

  if (options.diagonalRule === 'euclidean') {
    return { cells: Math.hypot(dx, dy), diagonalsSoFar: previousDiagonals + diagonals };
  }

  if (options.diagonalRule === 'equidistant') {
    return { cells: straight + diagonals, diagonalsSoFar: previousDiagonals + diagonals };
  }

  // 'alternating': la prima diagonale costa 1, la seconda 2, e così via.
  let cost = straight;
  let counter = previousDiagonals;
  for (let i = 0; i < diagonals; i += 1) {
    counter += 1;
    cost += counter % 2 === 0 ? 2 : 1;
  }
  return { cells: cost, diagonalsSoFar: counter };
}

export interface PathCostOptions extends StepCostOptions {
  /** Terreno della casella di arrivo di ogni passo. */
  terrainAt?: (cell: CellCoord) => TerrainKind;
}

export interface PathCostResult {
  cells: number;
  diagonals: number;
  /** True se il percorso attraversa almeno una casella impraticabile. */
  blocked: boolean;
  /** Costo cumulato passo per passo, per l'anteprima del percorso. */
  cumulative: number[];
}

/** Costo totale di un percorso espresso come sequenza di caselle. */
export function pathCostInCells(path: CellCoord[], options: PathCostOptions): PathCostResult {
  if (path.length <= 1) {
    return { cells: 0, diagonals: 0, blocked: false, cumulative: path.length === 1 ? [0] : [] };
  }
  let total = 0;
  let diagonalsSoFar = options.diagonalsSoFar ?? 0;
  const startDiagonals = diagonalsSoFar;
  let blocked = false;
  const cumulative: number[] = [0];

  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1];
    const to = path[i];
    if (!from || !to) continue;
    const step = stepCostInCells(from, to, { ...options, diagonalsSoFar });
    diagonalsSoFar = step.diagonalsSoFar;
    const terrain = options.terrainAt?.(to) ?? 'normal';
    if (terrain === 'impassable') {
      blocked = true;
      cumulative.push(total);
      continue;
    }
    const multiplier = terrain === 'difficult' ? options.difficultTerrainMultiplier : 1;
    total += step.cells * multiplier;
    cumulative.push(total);
  }

  return { cells: total, diagonals: diagonalsSoFar - startDiagonals, blocked, cumulative };
}

/** Caselle attraversate da una linea fra due caselle. */
export function lineCells(from: CellCoord, to: CellCoord): CellCoord[] {
  const cells: CellCoord[] = [];
  let x0 = from.col;
  let y0 = from.row;
  const x1 = to.col;
  const y1 = to.row;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ col: x0, row: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return cells;
}

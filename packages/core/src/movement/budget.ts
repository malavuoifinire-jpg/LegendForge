import type { GridConfiguration } from '../coordinates/grid.js';
import { metersToCells } from '../coordinates/grid.js';
import { speedFor, type MovementProfile } from './modes.js';

/**
 * Quanto può ancora muoversi chi si muove.
 *
 * Il budget è in metri, come tutte le distanze del dominio; le caselle sono
 * una lettura. Il residuo non scende mai sotto zero: un movimento che sfora
 * viene rifiutato prima, non registrato in negativo.
 */

export interface MovementBudget {
  /** Velocità del modo scelto, in metri. */
  totalMeters: number;
  usedMeters: number;
  remainingMeters: number;
  totalCells: number;
  usedCells: number;
  remainingCells: number;
  /** Vero se questa creatura non si muove affatto in questo modo. */
  immobile: boolean;
}

export function movementBudget(
  profile: MovementProfile,
  mode: string,
  usedMeters: number,
  grid: GridConfiguration,
): MovementBudget {
  const totalMeters = speedFor(profile, mode);
  const used = Math.max(0, Math.min(usedMeters, totalMeters));
  const remaining = Math.max(0, totalMeters - used);
  return {
    totalMeters,
    usedMeters: used,
    remainingMeters: remaining,
    totalCells: metersToCells(totalMeters, grid),
    usedCells: metersToCells(used, grid),
    remainingCells: metersToCells(remaining, grid),
    immobile: totalMeters <= 0,
  };
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Metri che mancherebbero, quando non basta. */
  shortfallMeters: number;
  reason: 'ok' | 'senza_movimento' | 'budget_esaurito';
}

/**
 * Se questo movimento ci sta nel budget.
 *
 * Il Game Master può autorizzare comunque: la decisione di ignorare questo
 * verdetto è sua, e sta un livello più su. Qui si dice solo com'è.
 */
export function fitsInBudget(budget: MovementBudget, costMeters: number): BudgetVerdict {
  if (budget.immobile) {
    return { allowed: false, shortfallMeters: costMeters, reason: 'senza_movimento' };
  }
  // Un pelo di tolleranza: i metri arrivano da divisioni, e rifiutare un
  // movimento per un millesimo sarebbe incomprensibile a chi sta giocando.
  const shortfall = costMeters - budget.remainingMeters;
  if (shortfall > 1e-6) {
    return { allowed: false, shortfallMeters: shortfall, reason: 'budget_esaurito' };
  }
  return { allowed: true, shortfallMeters: 0, reason: 'ok' };
}

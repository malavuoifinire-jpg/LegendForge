import { describe, expect, it } from 'vitest';
import { movementBudget, fitsInBudget } from './budget.js';
import { availableModes, behaviourOf, speedFor, DEFAULT_MOVEMENT_PROFILE } from './modes.js';
import { cellsThroughWaypoints, planMovement, straightMeters } from './path.js';
import { cellCenterToImagePoint, type GridConfiguration } from '../coordinates/grid.js';
import { pathCostInCells, stepCostInCells } from '../coordinates/distance.js';
import type { WallSegment } from '../vision/index.js';

/** Casella da 50 px che vale 1,5 m: il default di prodotto. */
const griglia: GridConfiguration = {
  cellSizePx: 50,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
  metersPerCell: 1.5,
  snapEnabled: true,
};

const centro = (col: number, row: number) => cellCenterToImagePoint({ col, row }, griglia);

function muro(ax: number, ay: number, bx: number, by: number): WallSegment {
  return { id: `m-${ax}-${ay}`, ax, ay, bx, by, kind: 'opaque', doorState: 'closed' };
}

describe('le tre regole diagonali', () => {
  const diagonale = [
    { col: 0, row: 0 },
    { col: 1, row: 1 },
    { col: 2, row: 2 },
    { col: 3, row: 3 },
    { col: 4, row: 4 },
  ];

  it('equidistante: ogni diagonale costa una casella', () => {
    const esito = pathCostInCells(diagonale, {
      diagonalRule: 'equidistant',
      difficultTerrainMultiplier: 2,
    });
    expect(esito.cells).toBe(4);
  });

  it('alternata: la prima costa 1, la seconda 2, e così via', () => {
    const esito = pathCostInCells(diagonale, {
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
    });
    // 1 + 2 + 1 + 2 = 6
    expect(esito.cells).toBe(6);
  });

  it('euclidea: la diagonale costa la radice di due', () => {
    const esito = pathCostInCells(diagonale, {
      diagonalRule: 'euclidean',
      difficultTerrainMultiplier: 2,
    });
    expect(esito.cells).toBeCloseTo(4 * Math.SQRT2, 9);
  });

  it('la regola alternata ricorda le diagonali del turno', () => {
    // Una diagonale sola, ma dopo una già percorsa: tocca a quella cara.
    const primo = stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, {
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      diagonalsSoFar: 0,
    });
    expect(primo.cells).toBe(1);
    const secondo = stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, {
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      diagonalsSoFar: 1,
    });
    expect(secondo.cells).toBe(2);
  });

  it('in linea retta le tre regole coincidono', () => {
    const dritto = [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ];
    for (const rule of ['equidistant', 'alternating', 'euclidean'] as const) {
      expect(
        pathCostInCells(dritto, { diagonalRule: rule, difficultTerrainMultiplier: 2 }).cells,
      ).toBeCloseTo(2, 9);
    }
  });
});

describe('percorso da waypoint', () => {
  it('unisce i waypoint in linea retta senza ripetere i giunti', () => {
    const cells = cellsThroughWaypoints([centro(0, 0), centro(3, 0), centro(3, 2)], griglia);
    expect(cells).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
      { col: 3, row: 1 },
      { col: 3, row: 2 },
    ]);
  });

  it('conta il costo in metri e casella per casella', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
    });
    expect(piano.costInCells).toBe(4);
    expect(piano.costInMeters).toBeCloseTo(6, 9);
    // Il cumulato serve all'etichetta che segue il dito.
    expect(piano.cumulativeMeters).toEqual([0, 1.5, 3, 4.5, 6]);
    expect(piano.stoppedAt).toBeNull();
  });

  it('un solo waypoint non costa niente', () => {
    const piano = planMovement([centro(2, 2)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
    });
    expect(piano.costInMeters).toBe(0);
    expect(piano.cells).toHaveLength(1);
  });

  it('il terreno difficile costa il doppio', () => {
    const difficile = new Set(['2,0', '3,0']);
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      terrainAt: (cell) => (difficile.has(`${cell.col},${cell.row}`) ? 'difficult' : 'normal'),
    });
    // Due caselle normali, due difficili: 1 + 1 + 2 + 2 = 6 caselle.
    expect(piano.costInCells).toBe(6);
    expect(piano.costInMeters).toBeCloseTo(9, 9);
  });

  it('un muro interrompe il percorso invece di rifiutarlo', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      walls: [muro(150, -100, 150, 400)],
    });
    expect(piano.reason).toBe('muro');
    expect(piano.stoppedAt).not.toBeNull();
    // Si arriva fino a prima del muro, e il costo è quello davvero percorso.
    expect(piano.cells.length).toBeLessThan(5);
    expect(piano.costInMeters).toBeLessThan(6);
    expect(piano.destination).not.toBeNull();
  });

  it('una casella impraticabile ferma come un muro', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      terrainAt: (cell) => (cell.col === 2 ? 'impassable' : 'normal'),
    });
    expect(piano.reason).toBe('terreno');
    expect(piano.cells.map((c) => c.col)).toEqual([0, 1]);
  });
});

describe('i modi di movimento', () => {
  it('volando il terreno difficile non rallenta', () => {
    const opzioni = {
      grid: griglia,
      diagonalRule: 'alternating' as const,
      difficultTerrainMultiplier: 2,
      terrainAt: () => 'difficult' as const,
    };
    const camminando = planMovement([centro(0, 0), centro(4, 0)], opzioni);
    const volando = planMovement([centro(0, 0), centro(4, 0)], { ...opzioni, mode: 'volare' });
    expect(camminando.costInCells).toBe(8);
    expect(volando.costInCells).toBe(4);
  });

  it('volando i muri fermano lo stesso', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      mode: 'volare',
      walls: [muro(150, -100, 150, 400)],
    });
    expect(piano.reason).toBe('muro');
  });

  it('scavando si passa attraverso', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      mode: 'scavare',
      walls: [muro(150, -100, 150, 400)],
    });
    expect(piano.reason).toBeNull();
    expect(piano.costInCells).toBe(4);
  });

  it('nemmeno volando si passa sull impraticabile', () => {
    const piano = planMovement([centro(0, 0), centro(4, 0)], {
      grid: griglia,
      diagonalRule: 'alternating',
      difficultTerrainMultiplier: 2,
      mode: 'volare',
      terrainAt: (cell) => (cell.col === 2 ? 'impassable' : 'normal'),
    });
    expect(piano.reason).toBe('terreno');
  });

  it('un modo inventato si comporta come il camminare', () => {
    expect(behaviourOf('planare fra i sogni')).toEqual(behaviourOf('camminare'));
    expect(behaviourOf(undefined).ignoresWalls).toBe(false);
  });

  it('i modi di una creatura sono quelli con una velocità', () => {
    const profilo = { camminare: 9, volare: 18, nuotare: 0 };
    // Il più veloce per primo: è quello che si sceglie più spesso.
    expect(availableModes(profilo)).toEqual(['volare', 'camminare']);
    expect(speedFor(profilo, 'nuotare')).toBe(0);
    expect(speedFor(profilo, 'scavare')).toBe(0);
    expect(availableModes(DEFAULT_MOVEMENT_PROFILE)).toEqual(['camminare']);
  });
});

describe('budget del movimento', () => {
  it('9 metri sono 6 caselle da 1,5 m', () => {
    const budget = movementBudget({ camminare: 9 }, 'camminare', 0, griglia);
    expect(budget.totalCells).toBeCloseTo(6, 9);
    expect(budget.remainingMeters).toBe(9);
  });

  it('il consumato scala il residuo', () => {
    const budget = movementBudget({ camminare: 9 }, 'camminare', 6, griglia);
    expect(budget.usedMeters).toBe(6);
    expect(budget.remainingMeters).toBe(3);
    expect(budget.remainingCells).toBeCloseTo(2, 9);
  });

  it('il residuo non va sotto zero', () => {
    const budget = movementBudget({ camminare: 9 }, 'camminare', 99, griglia);
    expect(budget.remainingMeters).toBe(0);
    expect(budget.usedMeters).toBe(9);
  });

  it('un movimento che ci sta viene accettato', () => {
    const budget = movementBudget({ camminare: 9 }, 'camminare', 0, griglia);
    expect(fitsInBudget(budget, 9)).toEqual({ allowed: true, shortfallMeters: 0, reason: 'ok' });
  });

  it('un movimento che sfora dice di quanto', () => {
    const budget = movementBudget({ camminare: 9 }, 'camminare', 6, griglia);
    const verdetto = fitsInBudget(budget, 4.5);
    expect(verdetto.allowed).toBe(false);
    expect(verdetto.reason).toBe('budget_esaurito');
    expect(verdetto.shortfallMeters).toBeCloseTo(1.5, 9);
  });

  it('chi non ha quel modo non si muove così', () => {
    const budget = movementBudget({ camminare: 9 }, 'volare', 0, griglia);
    expect(budget.immobile).toBe(true);
    expect(fitsInBudget(budget, 1).reason).toBe('senza_movimento');
  });

  it('un millesimo di metro non fa rifiutare un movimento', () => {
    // I metri arrivano da divisioni: rifiutare per un errore di virgola
    // sarebbe incomprensibile a chi sta giocando.
    const budget = movementBudget({ camminare: 9 }, 'camminare', 0, griglia);
    expect(fitsInBudget(budget, 9 + 1e-9).allowed).toBe(true);
  });
});

describe('distanza in linea d aria', () => {
  it('misura in metri senza passare dalle caselle', () => {
    expect(straightMeters({ x: 0, y: 0 }, { x: 100, y: 0 }, griglia)).toBeCloseTo(3, 9);
  });
});

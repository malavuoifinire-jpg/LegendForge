import { describe, expect, it } from 'vitest';
import { lineCells, pathCostInCells, stepCostInCells } from './distance.js';
import type { CellCoord } from './types.js';

const base = { difficultTerrainMultiplier: 2 } as const;

describe('algoritmi diagonali', () => {
  it('equidistant: ogni diagonale costa una casella', () => {
    const o = { ...base, diagonalRule: 'equidistant' as const };
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, o).cells).toBe(1);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 4, row: 4 }, o).cells).toBe(4);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 4, row: 2 }, o).cells).toBe(4);
  });

  it('alternating: costo 1, 2, 1, 2 sulle diagonali successive', () => {
    const o = { ...base, diagonalRule: 'alternating' as const };
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, o).cells).toBe(1);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 2, row: 2 }, o).cells).toBe(3);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 3, row: 3 }, o).cells).toBe(4);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 4, row: 4 }, o).cells).toBe(6);
  });

  it('alternating: il contatore prosegue fra passi successivi', () => {
    const o = { ...base, diagonalRule: 'alternating' as const };
    const first = stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, o);
    expect(first.cells).toBe(1);
    const second = stepCostInCells(
      { col: 1, row: 1 },
      { col: 2, row: 2 },
      { ...o, diagonalsSoFar: first.diagonalsSoFar },
    );
    expect(second.cells).toBe(2);
  });

  it('euclidean: distanza reale', () => {
    const o = { ...base, diagonalRule: 'euclidean' as const };
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 3, row: 4 }, o).cells).toBeCloseTo(5, 10);
    expect(stepCostInCells({ col: 0, row: 0 }, { col: 1, row: 1 }, o).cells).toBeCloseTo(Math.SQRT2, 10);
  });

  it('i movimenti ortogonali costano uguale con tutte le regole', () => {
    for (const diagonalRule of ['equidistant', 'alternating', 'euclidean'] as const) {
      expect(
        stepCostInCells({ col: 0, row: 0 }, { col: 5, row: 0 }, { ...base, diagonalRule }).cells,
      ).toBeCloseTo(5, 10);
    }
  });
});

describe('costo del percorso', () => {
  const path: CellCoord[] = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 2, row: 1 },
    { col: 3, row: 2 },
  ];

  it('somma i passi e restituisce i costi cumulati', () => {
    const result = pathCostInCells(path, { ...base, diagonalRule: 'alternating' });
    expect(result.cells).toBe(4);
    expect(result.cumulative).toEqual([0, 1, 2, 4]);
    expect(result.diagonals).toBe(2);
  });

  it('applica il moltiplicatore del terreno difficile', () => {
    const result = pathCostInCells(path, {
      ...base,
      diagonalRule: 'equidistant',
      terrainAt: (cell) => (cell.col === 2 ? 'difficult' : 'normal'),
    });
    expect(result.cells).toBe(4);
  });

  it('segnala un percorso che attraversa caselle impraticabili', () => {
    const result = pathCostInCells(path, {
      ...base,
      diagonalRule: 'equidistant',
      terrainAt: (cell) => (cell.col === 2 ? 'impassable' : 'normal'),
    });
    expect(result.blocked).toBe(true);
  });

  it('un percorso di una sola casella costa zero', () => {
    expect(pathCostInCells([{ col: 4, row: 4 }], { ...base, diagonalRule: 'alternating' })).toEqual({
      cells: 0,
      diagonals: 0,
      blocked: false,
      cumulative: [0],
    });
  });
});

describe('linea fra caselle', () => {
  it('include partenza e arrivo', () => {
    expect(lineCells({ col: 0, row: 0 }, { col: 3, row: 0 })).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ]);
  });

  it('gestisce le diagonali', () => {
    expect(lineCells({ col: 0, row: 0 }, { col: 2, row: 2 })).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 2 },
    ]);
  });
});

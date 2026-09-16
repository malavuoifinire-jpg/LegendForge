import { describe, expect, it } from 'vitest';
import {
  calibrateFromTwoPoints,
  cellCenterToImagePoint,
  cellCornerToImagePoint,
  cellsToMeters,
  cellsToPixels,
  footprintCells,
  formatDistance,
  imagePointToCell,
  imagePointToCellVector,
  metersToCells,
  metersToPixels,
  pixelsPerMeter,
  pixelsToCells,
  pixelsToMeters,
  snapImagePointToFootprint,
  type GridConfiguration,
} from './grid.js';
import { DEFAULT_RULE_SET } from '../rules/ruleset.js';

const grid: GridConfiguration = {
  cellSizePx: 100,
  offsetX: 20,
  offsetY: 10,
  rotationDeg: 0,
  metersPerCell: 1.5,
  snapEnabled: true,
};

describe('conversioni pixel, caselle e metri', () => {
  it('converte pixel in caselle tenendo conto dell offset', () => {
    expect(imagePointToCell({ x: 20, y: 10 }, grid)).toEqual({ col: 0, row: 0 });
    expect(imagePointToCell({ x: 119, y: 109 }, grid)).toEqual({ col: 0, row: 0 });
    expect(imagePointToCell({ x: 120, y: 110 }, grid)).toEqual({ col: 1, row: 1 });
    expect(imagePointToCell({ x: 19, y: 9 }, grid)).toEqual({ col: -1, row: -1 });
  });

  it('riporta angolo e centro di una casella in pixel', () => {
    expect(cellCornerToImagePoint({ col: 2, row: 3 }, grid)).toEqual({ x: 220, y: 310 });
    expect(cellCenterToImagePoint({ col: 2, row: 3 }, grid)).toEqual({ x: 270, y: 360 });
  });

  it('converte caselle e metri con 1,5 m per casella', () => {
    expect(cellsToMeters(1, grid)).toBe(1.5);
    expect(cellsToMeters(12, grid)).toBe(18);
    expect(metersToCells(36, grid)).toBe(24);
    expect(pixelsPerMeter(grid)).toBeCloseTo(100 / 1.5, 10);
  });

  it('converte pixel e metri in modo reversibile', () => {
    expect(pixelsToCells(250, grid)).toBe(2.5);
    expect(cellsToPixels(2.5, grid)).toBe(250);
    expect(pixelsToMeters(300, grid)).toBeCloseTo(4.5, 10);
    for (const px of [0, 1, 37.5, 512, 1999.75]) {
      expect(metersToPixels(pixelsToMeters(px, grid), grid)).toBeCloseTo(px, 9);
    }
  });

  it('rispetta i default: 18 m sono 12 caselle, 36 m sono 24', () => {
    const defaultGrid: GridConfiguration = {
      ...grid,
      metersPerCell: DEFAULT_RULE_SET.grid.defaultMetersPerCell,
    };
    expect(metersToCells(DEFAULT_RULE_SET.vision.defaultDarkvisionMeters, defaultGrid)).toBe(12);
    expect(metersToCells(DEFAULT_RULE_SET.vision.extendedDarkvisionMeters, defaultGrid)).toBe(24);
  });

  it('formatta la distanza in metri e caselle', () => {
    expect(formatDistance(18, grid, 1)).toEqual({ meters: 18, cells: 12, label: '18 m (12 caselle)' });
  });

  it('funziona con passi diversi da 100 px', () => {
    const fine: GridConfiguration = { ...grid, cellSizePx: 64, offsetX: 0, offsetY: 0 };
    expect(imagePointToCell({ x: 63.9, y: 0 }, fine)).toEqual({ col: 0, row: 0 });
    expect(imagePointToCell({ x: 64, y: 128 }, fine)).toEqual({ col: 1, row: 2 });
    expect(pixelsToMeters(64, fine)).toBeCloseTo(1.5, 10);
  });

  it('restituisce la frazione dentro la casella', () => {
    const v = imagePointToCellVector({ x: 70, y: 60 }, grid);
    expect(v.col).toBeCloseTo(0.5, 10);
    expect(v.row).toBeCloseTo(0.5, 10);
  });
});

describe('griglia ruotata', () => {
  const rotated: GridConfiguration = { ...grid, rotationDeg: 3 };

  it('è invertibile: cella, pixel, cella', () => {
    for (const cell of [
      { col: 0, row: 0 },
      { col: 5, row: 2 },
      { col: -3, row: 7 },
    ]) {
      expect(imagePointToCell(cellCenterToImagePoint(cell, rotated), rotated)).toEqual(cell);
    }
  });

  it('mantiene la distanza fra centri adiacenti pari al lato della casella', () => {
    const a = cellCenterToImagePoint({ col: 0, row: 0 }, rotated);
    const b = cellCenterToImagePoint({ col: 1, row: 0 }, rotated);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(rotated.cellSizePx, 10);
  });
});

describe('aggancio e impronta delle pedine', () => {
  it('aggancia una pedina media al centro della casella', () => {
    expect(snapImagePointToFootprint({ x: 233, y: 141 }, grid, 1)).toEqual({ x: 270, y: 160 });
  });

  it('aggancia una pedina di 2 caselle a un incrocio', () => {
    const snapped = snapImagePointToFootprint({ x: 233, y: 141 }, grid, 2);
    expect(snapped).toEqual({ x: 220, y: 110 });
    expect(footprintCells(snapped, grid, 2)).toEqual([
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 1 },
    ]);
  });

  it('una pedina piccola resta nella casella che la contiene', () => {
    expect(snapImagePointToFootprint({ x: 121, y: 111 }, grid, 0.5)).toEqual({ x: 170, y: 160 });
  });

  it('l aggancio è idempotente', () => {
    const once = snapImagePointToFootprint({ x: 401, y: 512 }, grid, 3);
    const twice = snapImagePointToFootprint(once, grid, 3);
    expect(twice.x).toBeCloseTo(once.x, 9);
    expect(twice.y).toBeCloseTo(once.y, 9);
  });
});

describe('calibrazione da due incroci', () => {
  it('ricava il passo da due punti sulla stessa riga', () => {
    const result = calibrateFromTwoPoints({ x: 20, y: 10 }, { x: 320, y: 10 }, 3);
    expect(result).not.toBeNull();
    expect(result!.cellSizePx).toBeCloseTo(100, 6);
    expect(result!.rotationDeg).toBeCloseTo(0, 6);
  });

  it('colloca gli incroci indicati su incroci reali della griglia', () => {
    const first = { x: 37, y: 61 };
    const second = { x: 437, y: 61 };
    const result = calibrateFromTwoPoints(first, second, 4)!;
    const calibrated: GridConfiguration = {
      ...result,
      metersPerCell: 1.5,
      snapEnabled: true,
    };
    for (const point of [first, second]) {
      const cell = imagePointToCellVector(point, calibrated);
      expect(Math.abs(cell.col - Math.round(cell.col))).toBeLessThan(1e-6);
      expect(Math.abs(cell.row - Math.round(cell.row))).toBeLessThan(1e-6);
    }
  });

  it('riconosce una lieve inclinazione', () => {
    const angle = (3 * Math.PI) / 180;
    const first = { x: 50, y: 50 };
    const second = { x: 50 + 400 * Math.cos(angle), y: 50 + 400 * Math.sin(angle) };
    const result = calibrateFromTwoPoints(first, second, 5)!;
    expect(result.cellSizePx).toBeCloseTo(80, 4);
    expect(result.rotationDeg).toBeCloseTo(3, 2);
  });

  it('riporta una inclinazione quasi verticale nel suo equivalente minimo', () => {
    // Due incroci sulla stessa colonna: la griglia è dritta, non ruotata di 90°.
    const result = calibrateFromTwoPoints({ x: 100, y: 20 }, { x: 100, y: 420 }, 4)!;
    expect(result.cellSizePx).toBeCloseTo(100, 6);
    expect(Math.abs(result.rotationDeg)).toBeLessThan(0.001);
  });

  it('rifiuta input privi di senso', () => {
    expect(calibrateFromTwoPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 0)).toBeNull();
    expect(calibrateFromTwoPoints({ x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toBeNull();
    // Due incroci troppo vicini per il numero di caselle dichiarato.
    expect(calibrateFromTwoPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, 50)).toBeNull();
  });
});

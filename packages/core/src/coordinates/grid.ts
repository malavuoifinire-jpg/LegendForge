import type { CellCoord, CellVector, ImagePoint } from './types.js';

/**
 * Configurazione della griglia di una scena.
 *
 * La griglia è una trasformazione affine (traslazione, rotazione, scala
 * uniforme) applicata sopra l'immagine: non viene mai impressa sui pixel.
 */
export interface GridConfiguration {
  /** Lato della casella, in pixel dell'immagine originale. */
  cellSizePx: number;
  /** Posizione in pixel dell'angolo della casella (0,0). */
  offsetX: number;
  /** Posizione in pixel dell'angolo della casella (0,0). */
  offsetY: number;
  /** Lieve rotazione della griglia rispetto agli assi immagine, in gradi. */
  rotationDeg: number;
  /** Metri rappresentati dal lato di una casella. */
  metersPerCell: number;
  /** Aggancio alla griglia attivo. */
  snapEnabled: boolean;
}

export const MIN_CELL_SIZE_PX = 4;
export const MAX_ROTATION_DEG = 15;

export function normalizeRotationDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return Math.max(-MAX_ROTATION_DEG, Math.min(MAX_ROTATION_DEG, deg));
}

function rotate(x: number, y: number, rad: number): ImagePoint {
  if (rad === 0) return { x, y };
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Converte un punto immagine in coordinate frazionarie di casella. */
export function imagePointToCellVector(p: ImagePoint, grid: GridConfiguration): CellVector {
  const rad = (-grid.rotationDeg * Math.PI) / 180;
  const local = rotate(p.x - grid.offsetX, p.y - grid.offsetY, rad);
  return { col: local.x / grid.cellSizePx, row: local.y / grid.cellSizePx };
}

/** Converte un punto immagine nella casella che lo contiene. */
export function imagePointToCell(p: ImagePoint, grid: GridConfiguration): CellCoord {
  const v = imagePointToCellVector(p, grid);
  return { col: Math.floor(v.col), row: Math.floor(v.row) };
}

/** Converte coordinate di casella, anche frazionarie, in punto immagine. */
export function cellVectorToImagePoint(v: CellVector, grid: GridConfiguration): ImagePoint {
  const rad = (grid.rotationDeg * Math.PI) / 180;
  const local = rotate(v.col * grid.cellSizePx, v.row * grid.cellSizePx, rad);
  return { x: local.x + grid.offsetX, y: local.y + grid.offsetY };
}

/** Angolo in alto a sinistra della casella, in pixel immagine. */
export function cellCornerToImagePoint(cell: CellCoord, grid: GridConfiguration): ImagePoint {
  return cellVectorToImagePoint({ col: cell.col, row: cell.row }, grid);
}

/** Centro della casella, in pixel immagine. */
export function cellCenterToImagePoint(cell: CellCoord, grid: GridConfiguration): ImagePoint {
  return cellVectorToImagePoint({ col: cell.col + 0.5, row: cell.row + 0.5 }, grid);
}

/**
 * Aggancia un punto al centro dell'impronta di una pedina.
 *
 * Una pedina di lato `footprintSize` occupa un blocco quadrato di caselle: il
 * centro cade sul centro di una casella per lati dispari e su un incrocio per
 * lati pari. Le pedine più piccole di una casella restano centrate nella
 * casella che le contiene.
 */
export function snapImagePointToFootprint(
  p: ImagePoint,
  grid: GridConfiguration,
  footprintSize = 1,
): ImagePoint {
  const size = Math.max(footprintSize, 0.01);
  const v = imagePointToCellVector(p, grid);
  if (size < 1) {
    return cellVectorToImagePoint(
      { col: Math.floor(v.col) + 0.5, row: Math.floor(v.row) + 0.5 },
      grid,
    );
  }
  const half = size / 2;
  return cellVectorToImagePoint(
    { col: Math.round(v.col - half) + half, row: Math.round(v.row - half) + half },
    grid,
  );
}

/** Caselle occupate dall'impronta quadrata centrata su `center`. */
export function footprintCells(
  center: ImagePoint,
  grid: GridConfiguration,
  footprintSize = 1,
): CellCoord[] {
  const size = Math.max(footprintSize, 0.01);
  const v = imagePointToCellVector(center, grid);
  const half = size / 2;
  const startCol = Math.floor(v.col - half + 1e-6);
  const startRow = Math.floor(v.row - half + 1e-6);
  const span = Math.max(1, Math.round(size));
  const cells: CellCoord[] = [];
  for (let r = 0; r < span; r += 1) {
    for (let c = 0; c < span; c += 1) {
      cells.push({ col: startCol + c, row: startRow + r });
    }
  }
  return cells;
}

/* ---------------------------- conversioni di unità ---------------------------- */

export function pixelsPerMeter(grid: GridConfiguration): number {
  return grid.cellSizePx / grid.metersPerCell;
}

export function cellsToMeters(cells: number, grid: GridConfiguration): number {
  return cells * grid.metersPerCell;
}

export function metersToCells(meters: number, grid: GridConfiguration): number {
  return meters / grid.metersPerCell;
}

export function pixelsToCells(px: number, grid: GridConfiguration): number {
  return px / grid.cellSizePx;
}

export function cellsToPixels(cells: number, grid: GridConfiguration): number {
  return cells * grid.cellSizePx;
}

export function pixelsToMeters(px: number, grid: GridConfiguration): number {
  return cellsToMeters(pixelsToCells(px, grid), grid);
}

export function metersToPixels(meters: number, grid: GridConfiguration): number {
  return cellsToPixels(metersToCells(meters, grid), grid);
}

/** Etichetta di distanza mostrata all'utente: metri e caselle insieme. */
export function formatDistance(
  meters: number,
  grid: GridConfiguration,
  precision = 1,
): { meters: number; cells: number; label: string } {
  const roundedMeters = Number(meters.toFixed(precision));
  const roundedCells = Number(metersToCells(meters, grid).toFixed(precision));
  return { meters: roundedMeters, cells: roundedCells, label: `${roundedMeters} m (${roundedCells} caselle)` };
}

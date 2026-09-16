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

/* ------------------------- calibrazione manuale --------------------------- */

export interface TwoPointCalibration {
  cellSizePx: number;
  offsetX: number;
  offsetY: number;
  rotationDeg: number;
}

/**
 * Ricava passo, offset e rotazione da due incroci noti della griglia.
 *
 * È la via di uscita quando il rilevamento automatico sbaglia: il Game Master
 * indica due incroci e quante caselle li separano, e da lì si ricostruisce
 * l'intera trasformazione. I due punti devono stare sulla stessa riga o sulla
 * stessa colonna, altrimenti un solo numero non basta a determinare il passo.
 *
 * L'angolo viene riportato nell'intervallo (-45, 45] e poi limitato alla
 * rotazione massima ammessa: una griglia quadrata è indistinguibile da se
 * stessa ogni 90 gradi, quindi un'inclinazione di 89 gradi è in realtà -1.
 */
export function calibrateFromTwoPoints(
  first: ImagePoint,
  second: ImagePoint,
  cellsBetween: number,
): TwoPointCalibration | null {
  if (!Number.isFinite(cellsBetween) || cellsBetween <= 0) return null;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return null;

  const cellSizePx = distance / cellsBetween;
  if (cellSizePx < MIN_CELL_SIZE_PX) return null;

  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  angle = ((angle % 90) + 135) % 90 - 45;
  const rotationDeg = normalizeRotationDeg(angle);

  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wrap = (value: number): number => {
    const wrapped = value % cellSizePx;
    return wrapped < 0 ? wrapped + cellSizePx : wrapped;
  };
  // L'origine è il primo incrocio riportato nella cella (0,0).
  const u = wrap(first.x * cos + first.y * sin);
  const v = wrap(-first.x * sin + first.y * cos);

  return {
    cellSizePx: Number(cellSizePx.toFixed(4)),
    offsetX: Number((u * cos - v * sin).toFixed(4)),
    offsetY: Number((u * sin + v * cos).toFixed(4)),
    rotationDeg: Number(rotationDeg.toFixed(3)),
  };
}

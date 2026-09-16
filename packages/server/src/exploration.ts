import type { Viewpoint } from '@legendforge/contracts';
import {
  cellCenterToImagePoint,
  imagePointToCell,
  polygonContains,
  type GridConfiguration,
} from '@legendforge/core';
import type { ServerContext } from './context.js';

/**
 * Memoria di quello che si è già visto.
 *
 * Il fog of war ha tre stati, non due: mai visto, visto prima e adesso al
 * buio, visibile adesso. Il terzo lo dice il poligono; il secondo ha bisogno di
 * una memoria, e la memoria è di chi ha esplorato — quello che ha visto il mio
 * personaggio non è quello che ha visto il tuo.
 *
 * La forma è una mappa di bit sulle caselle: piccola da salvare, banale da
 * fondere (un OR), e sempre allineata alla griglia. Se la griglia cambia la
 * memoria va buttata, perché gli stessi bit indicherebbero caselle diverse: è
 * la firma a dirlo.
 */

/** Oltre questa larghezza in caselle la memoria non si tiene: sarebbe enorme. */
const MAX_SIDE_CELLS = 400;

export interface ExplorationBounds {
  originCol: number;
  originRow: number;
  widthCells: number;
  heightCells: number;
}

export interface ExplorationState extends ExplorationBounds {
  signature: string;
  /** Un bit per casella, in ordine di riga. */
  bits: Uint8Array;
}

/**
 * Firma della griglia.
 *
 * Cambia quando cambia una qualsiasi cosa che sposta le caselle sotto i piedi
 * dell'immagine: passo, scostamento, rotazione, o la mappa stessa.
 */
export function gridSignature(grid: GridConfiguration, mapAssetId: string | null): string {
  return [
    mapAssetId ?? 'nessuna',
    grid.cellSizePx.toFixed(4),
    grid.offsetX.toFixed(4),
    grid.offsetY.toFixed(4),
    grid.rotationDeg.toFixed(4),
  ].join('|');
}

/**
 * Riquadro di caselle coperto dalla scena.
 *
 * Con una mappa sono le caselle che la coprono; senza, una superficie fissa
 * attorno all'origine — quella su cui si lavora quando non c'è un'immagine.
 */
export function boundsFor(
  grid: GridConfiguration,
  map: { widthPx: number; heightPx: number } | null,
): ExplorationBounds | null {
  const width = map ? map.widthPx : 4000;
  const height = map ? map.heightPx : 4000;
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ].map((point) => imagePointToCell(point, grid));

  const minCol = Math.min(...corners.map((cell) => cell.col));
  const maxCol = Math.max(...corners.map((cell) => cell.col));
  const minRow = Math.min(...corners.map((cell) => cell.row));
  const maxRow = Math.max(...corners.map((cell) => cell.row));

  const widthCells = maxCol - minCol + 1;
  const heightCells = maxRow - minRow + 1;
  if (widthCells > MAX_SIDE_CELLS || heightCells > MAX_SIDE_CELLS) return null;
  if (widthCells <= 0 || heightCells <= 0) return null;
  return { originCol: minCol, originRow: minRow, widthCells, heightCells };
}

function byteLength(bounds: ExplorationBounds): number {
  return Math.ceil((bounds.widthCells * bounds.heightCells) / 8);
}

function setBit(bits: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  const mask = 1 << (index & 7);
  const current = bits[byte] ?? 0;
  if ((current & mask) !== 0) return false;
  bits[byte] = current | mask;
  return true;
}

/**
 * Accende i bit delle caselle che si vedono adesso.
 *
 * Si guardano solo le caselle dentro al riquadro della portata: il resto del
 * riquadro non può essere visibile, e provarlo costerebbe soltanto.
 * Restituisce quante caselle sono state scoperte in questo passaggio.
 */
export function markVisible(
  state: ExplorationState,
  viewpoints: readonly Viewpoint[],
  grid: GridConfiguration,
): number {
  let discovered = 0;
  for (const viewpoint of viewpoints) {
    if (viewpoint.polygon.length < 3) continue;
    const reach = viewpoint.radiusPx;
    const corners = [
      { x: viewpoint.origin.x - reach, y: viewpoint.origin.y - reach },
      { x: viewpoint.origin.x + reach, y: viewpoint.origin.y - reach },
      { x: viewpoint.origin.x - reach, y: viewpoint.origin.y + reach },
      { x: viewpoint.origin.x + reach, y: viewpoint.origin.y + reach },
    ].map((point) => imagePointToCell(point, grid));

    const fromCol = Math.max(state.originCol, Math.min(...corners.map((c) => c.col)));
    const toCol = Math.min(
      state.originCol + state.widthCells - 1,
      Math.max(...corners.map((c) => c.col)),
    );
    const fromRow = Math.max(state.originRow, Math.min(...corners.map((c) => c.row)));
    const toRow = Math.min(
      state.originRow + state.heightCells - 1,
      Math.max(...corners.map((c) => c.row)),
    );

    for (let row = fromRow; row <= toRow; row += 1) {
      for (let col = fromCol; col <= toCol; col += 1) {
        const index =
          (row - state.originRow) * state.widthCells + (col - state.originCol);
        const byte = index >> 3;
        const mask = 1 << (index & 7);
        if (((state.bits[byte] ?? 0) & mask) !== 0) continue;
        const center = cellCenterToImagePoint({ col, row }, grid);
        if (!polygonContains(viewpoint.polygon, center)) continue;
        if (setBit(state.bits, index)) discovered += 1;
      }
    }
  }
  return discovered;
}

interface ExplorationRow {
  grid_signature: string;
  origin_col: number;
  origin_row: number;
  width_cells: number;
  height_cells: number;
  explored: Buffer;
}

/**
 * Aggiorna la memoria con quello che si vede adesso e la restituisce.
 *
 * Si scrive solo quando qualcosa è stato davvero scoperto: la rotta del campo
 * visivo viene chiamata a ogni passo, e una scrittura per ogni lettura sarebbe
 * un peso senza motivo.
 */
export async function rememberAndLoad(
  context: ServerContext,
  sceneId: string,
  userId: string,
  viewpoints: readonly Viewpoint[],
  grid: GridConfiguration,
  map: { widthPx: number; heightPx: number } | null,
  mapAssetId: string | null,
): Promise<ExplorationState | null> {
  const bounds = boundsFor(grid, map);
  if (!bounds) return null;
  const signature = gridSignature(grid, mapAssetId);

  const { rows } = await context.pool.query<ExplorationRow>(
    `SELECT grid_signature, origin_col, origin_row, width_cells, height_cells, explored
       FROM scene_exploration WHERE scene_id = $1 AND user_id = $2`,
    [sceneId, userId],
  );
  const row = rows[0];

  const usable =
    row !== undefined &&
    row.grid_signature === signature &&
    row.origin_col === bounds.originCol &&
    row.origin_row === bounds.originRow &&
    row.width_cells === bounds.widthCells &&
    row.height_cells === bounds.heightCells;

  const state: ExplorationState = {
    ...bounds,
    signature,
    bits: usable ? new Uint8Array(row.explored) : new Uint8Array(byteLength(bounds)),
  };
  if (usable && state.bits.length !== byteLength(bounds)) {
    state.bits = new Uint8Array(byteLength(bounds));
  }

  const discovered = markVisible(state, viewpoints, grid);
  if (discovered > 0 || !usable) {
    await context.pool
      .query(
        `INSERT INTO scene_exploration
           (scene_id, user_id, grid_signature, origin_col, origin_row,
            width_cells, height_cells, explored)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (scene_id, user_id) DO UPDATE
            SET grid_signature = EXCLUDED.grid_signature,
                origin_col     = EXCLUDED.origin_col,
                origin_row     = EXCLUDED.origin_row,
                width_cells    = EXCLUDED.width_cells,
                height_cells   = EXCLUDED.height_cells,
                explored       = EXCLUDED.explored,
                updated_at     = now()`,
        [
          sceneId,
          userId,
          signature,
          bounds.originCol,
          bounds.originRow,
          bounds.widthCells,
          bounds.heightCells,
          Buffer.from(state.bits),
        ],
      )
      .catch(() => undefined);
  }
  return state;
}

/** Dimentica l'esplorato di una scena, per tutti o per una persona sola. */
export async function forgetExploration(
  context: ServerContext,
  sceneId: string,
  userId?: string,
): Promise<void> {
  if (userId) {
    await context.pool.query(
      'DELETE FROM scene_exploration WHERE scene_id = $1 AND user_id = $2',
      [sceneId, userId],
    );
    return;
  }
  await context.pool.query('DELETE FROM scene_exploration WHERE scene_id = $1', [sceneId]);
}

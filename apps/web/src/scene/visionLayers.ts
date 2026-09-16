import type { Exploration, LightSource, SceneVisionState, Wall } from '@legendforge/contracts';
import {
  cellCornerToImagePoint,
  imagePointToCell,
  imageToScreen,
  screenToImage,
  type GridConfiguration,
  type ImagePoint,
  type Viewport,
} from '@legendforge/core';

/**
 * Strati del buio, dei muri e delle luci.
 *
 * Il buio non si può disegnare direttamente sul canvas principale: bucarlo
 * cancellerebbe anche la mappa sottostante. Si prepara quindi su una tela
 * separata — buio pieno, poi i poligoni ritagliati via — e si appoggia il
 * risultato sopra la scena. Così i poligoni che si sovrappongono restano
 * aperti, invece di richiudersi a vicenda.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Colori dei muri, per tipo: il Game Master deve distinguerli a colpo d'occhio. */
export const WALL_STYLES: Record<Wall['kind'], { color: string; dash: number[]; label: string }> = {
  opaque: { color: '#e2e8f0', dash: [], label: 'Muro' },
  door: { color: '#fbbf24', dash: [], label: 'Porta' },
  window: { color: '#7dd3fc', dash: [7, 4], label: 'Finestra' },
  sight_blocker: { color: '#c084fc', dash: [3, 3], label: 'Tenda' },
  movement_blocker: { color: '#4ade80', dash: [10, 4], label: 'Barriera' },
};

let fogCanvas: HTMLCanvasElement | null = null;

function fogSurface(width: number, height: number): HTMLCanvasElement {
  if (!fogCanvas) fogCanvas = document.createElement('canvas');
  if (fogCanvas.width !== width || fogCanvas.height !== height) {
    fogCanvas.width = width;
    fogCanvas.height = height;
  }
  return fogCanvas;
}

/**
 * Stende il buio sulla mappa e ci ritaglia dentro quello che si vede.
 *
 * Il ritaglio usa `destination-out` su una tela di servizio: sul canvas
 * principale cancellerebbe la mappa insieme al buio.
 */
/** Quanto si alleggerisce il buio dove si è già stati. */
const EXPLORED_RELIEF = 0.42;

/** La mappa di bit dell'esplorato, decodificata una volta sola per stringa. */
let decodedCells: { source: string; bits: Uint8Array } | null = null;

function cellBits(exploration: Exploration): Uint8Array {
  if (decodedCells && decodedCells.source === exploration.cells) return decodedCells.bits;
  const binary = atob(exploration.cells);
  const bits = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bits[i] = binary.charCodeAt(i);
  decodedCells = { source: exploration.cells, bits };
  return bits;
}

/**
 * Traccia il contorno delle caselle già esplorate che si vedono adesso sullo
 * schermo. Si guardano solo quelle: il resto della mappa di bit non è
 * inquadrato, e scorrerlo tutto costerebbe soltanto.
 */
function pathExploredCells(
  fog: CanvasRenderingContext2D,
  exploration: Exploration,
  grid: GridConfiguration,
  viewport: Viewport,
  size: { width: number; height: number },
): void {
  const bits = cellBits(exploration);
  const corners = [
    screenToImage({ x: 0, y: 0 }, viewport),
    screenToImage({ x: size.width, y: 0 }, viewport),
    screenToImage({ x: 0, y: size.height }, viewport),
    screenToImage({ x: size.width, y: size.height }, viewport),
  ].map((point) => imagePointToCell(point, grid));

  const fromCol = Math.max(exploration.originCol, Math.min(...corners.map((c) => c.col)) - 1);
  const toCol = Math.min(
    exploration.originCol + exploration.widthCells - 1,
    Math.max(...corners.map((c) => c.col)) + 1,
  );
  const fromRow = Math.max(exploration.originRow, Math.min(...corners.map((c) => c.row)) - 1);
  const toRow = Math.min(
    exploration.originRow + exploration.heightCells - 1,
    Math.max(...corners.map((c) => c.row)) + 1,
  );

  fog.beginPath();
  for (let row = fromRow; row <= toRow; row += 1) {
    for (let col = fromCol; col <= toCol; col += 1) {
      const index =
        (row - exploration.originRow) * exploration.widthCells + (col - exploration.originCol);
      const byte = bits[index >> 3] ?? 0;
      if ((byte & (1 << (index & 7))) === 0) continue;
      // Un filo più larghe della casella: altrimenti restano righe di buio
      // fra una e l'altra per l'arrotondamento dei pixel.
      const quad = [
        cellCornerToImagePoint({ col, row }, grid),
        cellCornerToImagePoint({ col: col + 1, row }, grid),
        cellCornerToImagePoint({ col: col + 1, row: row + 1 }, grid),
        cellCornerToImagePoint({ col, row: row + 1 }, grid),
      ].map((point) => imageToScreen(point, viewport));
      const first = quad[0];
      if (!first) continue;
      fog.moveTo(first.x, first.y);
      for (const point of quad.slice(1)) fog.lineTo(point.x, point.y);
      fog.closePath();
    }
  }
}

export function drawFog(
  ctx: CanvasRenderingContext2D,
  vision: SceneVisionState,
  viewport: Viewport,
  size: { width: number; height: number },
  mapRect: Rect,
  grid: GridConfiguration,
): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const surface = fogSurface(Math.round(size.width * ratio), Math.round(size.height * ratio));
  const fog = surface.getContext('2d');
  if (!fog) return;

  fog.setTransform(ratio, 0, 0, ratio, 0, 0);
  fog.clearRect(0, 0, size.width, size.height);
  fog.globalCompositeOperation = 'source-over';

  // Il buio copre soltanto la mappa: fuori non c'è niente da nascondere.
  fog.fillStyle = 'rgba(3, 5, 10, 0.94)';
  fog.fillRect(mapRect.x, mapRect.y, mapRect.width, mapRect.height);

  // Dove si è già stati il buio si alleggerisce, senza aprirsi: si ricorda la
  // stanza, non si vede chi ci è entrato adesso.
  if (vision.exploration) {
    fog.globalCompositeOperation = 'destination-out';
    fog.globalAlpha = EXPLORED_RELIEF;
    pathExploredCells(fog, vision.exploration, grid, viewport, size);
    fog.fill();
    fog.globalAlpha = 1;
  }

  fog.globalCompositeOperation = 'destination-out';
  for (const viewpoint of vision.viewpoints) {
    if (viewpoint.polygon.length < 3) continue;
    fog.beginPath();
    for (const [index, point] of viewpoint.polygon.entries()) {
      const screen = imageToScreen(point, viewport);
      if (index === 0) fog.moveTo(screen.x, screen.y);
      else fog.lineTo(screen.x, screen.y);
    }
    fog.closePath();
    fog.fill();
  }

  fog.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(surface, 0, 0, size.width, size.height);
}

/** Alone chiaro attorno a ogni punto di vista: dice fin dove si arriva. */
export function drawSightEdges(
  ctx: CanvasRenderingContext2D,
  vision: SceneVisionState,
  viewport: Viewport,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(148, 197, 255, 0.28)';
  ctx.lineWidth = 1;
  for (const viewpoint of vision.viewpoints) {
    if (viewpoint.polygon.length < 3) continue;
    ctx.beginPath();
    for (const [index, point] of viewpoint.polygon.entries()) {
      const screen = imageToScreen(point, viewport);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawWalls(
  ctx: CanvasRenderingContext2D,
  walls: readonly Wall[],
  viewport: Viewport,
  selectedId: string | null,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  for (const wall of walls) {
    const a = imageToScreen({ x: wall.ax, y: wall.ay }, viewport);
    const b = imageToScreen({ x: wall.bx, y: wall.by }, viewport);
    const style = WALL_STYLES[wall.kind];
    const open = wall.kind === 'door' && wall.doorState === 'open';
    const locked = wall.kind === 'door' && wall.doorState === 'locked';

    ctx.setLineDash(open ? [4, 6] : style.dash);
    ctx.strokeStyle = locked ? '#f87171' : style.color;
    ctx.globalAlpha = open ? 0.5 : 0.9;
    ctx.lineWidth = wall.id === selectedId ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (wall.id === selectedId) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f8fafc';
      for (const end of [a, b]) {
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** La spezzata che il Game Master sta disegnando in questo momento. */
export function drawDraftWall(
  ctx: CanvasRenderingContext2D,
  points: readonly ImagePoint[],
  cursor: ImagePoint | null,
  viewport: Viewport,
): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = '#7ee7ff';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  for (const [index, point] of points.entries()) {
    const screen = imageToScreen(point, viewport);
    if (index === 0) ctx.moveTo(screen.x, screen.y);
    else ctx.lineTo(screen.x, screen.y);
  }
  if (cursor) {
    const screen = imageToScreen(cursor, viewport);
    ctx.lineTo(screen.x, screen.y);
  }
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = '#7ee7ff';
  for (const point of points) {
    const screen = imageToScreen(point, viewport);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawLights(
  ctx: CanvasRenderingContext2D,
  lights: readonly LightSource[],
  tokenPositions: Map<string, ImagePoint>,
  pixelsPerMeter: number,
  viewport: Viewport,
  selectedId: string | null,
): void {
  ctx.save();
  for (const light of lights) {
    const anchor = light.tokenId ? tokenPositions.get(light.tokenId) : undefined;
    const position = anchor ?? { x: light.x, y: light.y };
    const screen = imageToScreen(position, viewport);
    const spent = light.remainingMinutes !== null && light.remainingMinutes <= 0;
    const on = light.enabled && !spent;

    for (const [radiusMeters, alpha] of [
      [light.dimRadiusMeters, 0.08],
      [light.brightRadiusMeters, 0.14],
    ] as const) {
      const radius = radiusMeters * pixelsPerMeter * viewport.zoom;
      if (radius < 2) continue;
      ctx.globalAlpha = on ? alpha : alpha / 3;
      ctx.fillStyle = light.color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, light.id === selectedId ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = on ? light.color : '#475569';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = light.id === selectedId ? '#f8fafc' : 'rgba(0,0,0,0.6)';
    ctx.stroke();
  }
  ctx.restore();
}

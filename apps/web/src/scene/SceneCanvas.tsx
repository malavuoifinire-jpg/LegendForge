import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  cellCornerToImagePoint,
  fitToViewport,
  imagePointToCell,
  imageToScreen,
  panBy,
  screenToImage,
  snapImagePointToFootprint,
  zoomAt,
  type CellCoord,
  type GridConfiguration,
  type ImagePoint,
  type Viewport,
} from '@legendforge/core';
import type { CanvasMap, CanvasToken } from './types';

interface SceneCanvasProps {
  map: CanvasMap | null;
  grid: GridConfiguration;
  gridVisible: boolean;
  tokens: CanvasToken[];
  selectedTokenId: string | null;
  onSelectToken: (id: string | null) => void;
  onMoveToken: (id: string, position: ImagePoint) => void;
  onViewportChange?: (viewport: Viewport) => void;
  /** Dimensioni correnti dell'area visibile, in pixel schermo. */
  onSizeChange?: (size: { width: number; height: number }) => void;
  onHoverCell?: (cell: CellCoord | null) => void;
  /** Chiamata quando il trascinamento finisce: è il momento di salvare. */
  onCommitToken?: (id: string) => void;
  /**
   * Modalità di raccolta punti per la calibrazione: il clic indica un incrocio
   * invece di selezionare una pedina.
   */
  picking?: boolean;
  onPickPoint?: (point: ImagePoint) => void;
  /** Punti già raccolti, disegnati come riferimento. */
  pickedPoints?: ImagePoint[];
}

type Interaction =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'token'; id: string; grabOffsetX: number; grabOffsetY: number };

const GRID_LINE_COLOR = 'rgba(126, 231, 255, 0.34)';
const GRID_AXIS_COLOR = 'rgba(126, 231, 255, 0.7)';

export function SceneCanvas({
  map,
  grid,
  gridVisible,
  tokens,
  selectedTokenId,
  onSelectToken,
  onMoveToken,
  onViewportChange,
  onSizeChange,
  onHoverCell,
  onCommitToken,
  picking = false,
  onPickPoint,
  pickedPoints,
}: SceneCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionRef = useRef<Interaction>({ kind: 'none' });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const initialisedRef = useRef(false);

  /* ----------------------------- dimensionamento ---------------------------- */

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!map || size.width === 0) return;
    setViewport(fitToViewport({ width: map.width, height: map.height }, size, 32));
  }, [map, size]);

  useEffect(() => {
    if (initialisedRef.current || !map || size.width === 0) return;
    initialisedRef.current = true;
    fit();
  }, [fit, map, size.width]);

  useEffect(() => {
    onViewportChange?.(viewport);
  }, [viewport, onViewportChange]);

  useEffect(() => {
    if (size.width > 0) onSizeChange?.(size);
  }, [size, onSizeChange]);

  /* -------------------------------- disegno -------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, size.width, size.height);

    if (!map) return;

    // Mappa
    const origin = imageToScreen({ x: 0, y: 0 }, viewport);
    ctx.imageSmoothingEnabled = viewport.zoom < 2;
    ctx.drawImage(
      map.source,
      origin.x,
      origin.y,
      map.width * viewport.zoom,
      map.height * viewport.zoom,
    );

    // Bordo della mappa, per rendere visibile dove finisce
    ctx.strokeStyle = 'rgba(126, 231, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      origin.x - 0.5,
      origin.y - 0.5,
      map.width * viewport.zoom + 1,
      map.height * viewport.zoom + 1,
    );

    // Griglia sovrapposta: mai impressa sull'immagine
    if (gridVisible) drawGrid(ctx, map, grid, viewport, size);

    // Pedine
    for (const token of tokens) {
      drawToken(ctx, token, grid, viewport, token.id === selectedTokenId);
    }

    // Punti raccolti per la calibrazione
    for (const [index, point] of (pickedPoints ?? []).entries()) {
      drawPickedPoint(ctx, point, viewport, index + 1);
    }
  }, [map, grid, gridVisible, tokens, selectedTokenId, viewport, size, pickedPoints]);

  /* ------------------------------ interazione ------------------------------ */

  const tokenAtPoint = useCallback(
    (point: ImagePoint): CanvasToken | null => {
      for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const token = tokens[i];
        if (!token) continue;
        const radius = (token.sizeInCells * grid.cellSizePx) / 2;
        if (Math.hypot(point.x - token.x, point.y - token.y) <= radius) return token;
      }
      return null;
    },
    [tokens, grid.cellSizePx],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const image = screenToImage(screen, viewport);

      if (picking && event.button === 0) {
        onPickPoint?.(image);
        return;
      }

      const token = tokenAtPoint(image);

      if (token && event.button === 0) {
        interactionRef.current = {
          kind: 'token',
          id: token.id,
          grabOffsetX: image.x - token.x,
          grabOffsetY: image.y - token.y,
        };
        onSelectToken(token.id);
        return;
      }

      if (event.button === 0) onSelectToken(null);
      interactionRef.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
    },
    [viewport, tokenAtPoint, onSelectToken, picking, onPickPoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const image = screenToImage(screen, viewport);
      onHoverCell?.(imagePointToCell(image, grid));

      const interaction = interactionRef.current;
      if (interaction.kind === 'pan') {
        const dx = event.clientX - interaction.lastX;
        const dy = event.clientY - interaction.lastY;
        interactionRef.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
        setViewport((current) => panBy(current, dx, dy));
        return;
      }

      if (interaction.kind === 'token') {
        onMoveToken(interaction.id, {
          x: image.x - interaction.grabOffsetX,
          y: image.y - interaction.grabOffsetY,
        });
      }
    },
    [viewport, grid, onHoverCell, onMoveToken],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      canvas?.releasePointerCapture(event.pointerId);
      const interaction = interactionRef.current;
      interactionRef.current = { kind: 'none' };

      if (interaction.kind !== 'token') return;
      const token = tokens.find((candidate) => candidate.id === interaction.id);
      if (!token) return;

      if (grid.snapEnabled) {
        onMoveToken(
          token.id,
          snapImagePointToFootprint({ x: token.x, y: token.y }, grid, token.sizeInCells),
        );
      }
      // Il salvataggio avviene a fine gesto, non a ogni pixel percorso.
      onCommitToken?.(token.id);
    },
    [grid, tokens, onMoveToken, onCommitToken],
  );

  // Lo zoom con la rotella richiede un listener non passivo: React registra
  // `onWheel` come passivo e non potrebbe annullare lo zoom della pagina.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0016);
      setViewport((current) => zoomAt(current, anchor, factor));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="scene-canvas" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={fit}
        onPointerLeave={() => onHoverCell?.(null)}
      />
      <button type="button" className="scene-canvas__fit" onClick={fit}>
        Inquadra la mappa
      </button>
      {picking && <div className="scene-canvas__picking">Clicca un incrocio della griglia</div>}
    </div>
  );
}

/* --------------------------------- disegno -------------------------------- */

function drawGrid(
  ctx: CanvasRenderingContext2D,
  map: { width: number; height: number },
  grid: GridConfiguration,
  viewport: Viewport,
  size: { width: number; height: number },
): void {
  const step = grid.cellSizePx * viewport.zoom;
  if (step < 6) return; // Sotto questa soglia la griglia è rumore visivo.

  // Intervallo di caselle che copre l'area visibile, con un margine.
  const corners: ImagePoint[] = [
    screenToImage({ x: 0, y: 0 }, viewport),
    screenToImage({ x: size.width, y: 0 }, viewport),
    screenToImage({ x: 0, y: size.height }, viewport),
    screenToImage({ x: size.width, y: size.height }, viewport),
  ];
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const corner of corners) {
    const cell = imagePointToCell(corner, grid);
    minCol = Math.min(minCol, cell.col - 1);
    maxCol = Math.max(maxCol, cell.col + 2);
    minRow = Math.min(minRow, cell.row - 1);
    maxRow = Math.max(maxRow, cell.row + 2);
  }
  if (!Number.isFinite(minCol) || maxCol - minCol > 400 || maxRow - minRow > 400) return;

  ctx.save();
  ctx.beginPath();
  const mapOrigin = imageToScreen({ x: 0, y: 0 }, viewport);
  ctx.rect(mapOrigin.x, mapOrigin.y, map.width * viewport.zoom, map.height * viewport.zoom);
  ctx.clip();

  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID_LINE_COLOR;
  ctx.beginPath();
  for (let col = minCol; col <= maxCol; col += 1) {
    const from = imageToScreen(cellCornerToImagePoint({ col, row: minRow }, grid), viewport);
    const to = imageToScreen(cellCornerToImagePoint({ col, row: maxRow }, grid), viewport);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  for (let row = minRow; row <= maxRow; row += 1) {
    const from = imageToScreen(cellCornerToImagePoint({ col: minCol, row }, grid), viewport);
    const to = imageToScreen(cellCornerToImagePoint({ col: maxCol, row }, grid), viewport);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();

  // Assi della casella (0,0): rendono visibile l'offset durante la calibrazione.
  ctx.strokeStyle = GRID_AXIS_COLOR;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const axisA = imageToScreen(cellCornerToImagePoint({ col: 0, row: minRow }, grid), viewport);
  const axisB = imageToScreen(cellCornerToImagePoint({ col: 0, row: maxRow }, grid), viewport);
  ctx.moveTo(axisA.x, axisA.y);
  ctx.lineTo(axisB.x, axisB.y);
  const axisC = imageToScreen(cellCornerToImagePoint({ col: minCol, row: 0 }, grid), viewport);
  const axisD = imageToScreen(cellCornerToImagePoint({ col: maxCol, row: 0 }, grid), viewport);
  ctx.moveTo(axisC.x, axisC.y);
  ctx.lineTo(axisD.x, axisD.y);
  ctx.stroke();
  ctx.restore();
}

function drawPickedPoint(
  ctx: CanvasRenderingContext2D,
  point: ImagePoint,
  viewport: Viewport,
  index: number,
): void {
  const screen = imageToScreen(point, viewport);
  ctx.save();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(screen.x - 9, screen.y);
  ctx.lineTo(screen.x + 9, screen.y);
  ctx.moveTo(screen.x, screen.y - 9);
  ctx.lineTo(screen.x, screen.y + 9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fbbf24';
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(index), screen.x + 16, screen.y - 8);
  ctx.restore();
}

function drawToken(
  ctx: CanvasRenderingContext2D,
  token: CanvasToken,
  grid: GridConfiguration,
  viewport: Viewport,
  selected: boolean,
): void {
  const center = imageToScreen({ x: token.x, y: token.y }, viewport);
  const radius = (token.sizeInCells * grid.cellSizePx * viewport.zoom) / 2;
  if (radius < 1) return;

  ctx.save();
  if (token.hidden) ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius * 0.94, 0, Math.PI * 2);
  ctx.fillStyle = token.color;
  ctx.fill();

  ctx.lineWidth = Math.max(1.5, radius * 0.08);
  ctx.strokeStyle = selected ? '#f8fafc' : 'rgba(0,0,0,0.65)';
  if (token.hidden) ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (selected) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * 1.12, 0, Math.PI * 2);
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(248,250,252,0.85)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const label = token.name.slice(0, 2).toUpperCase();
  const fontSize = radius * 0.7;
  if (fontSize >= 8) {
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(12,14,18,0.9)';
    ctx.fillText(label, center.x, center.y + fontSize * 0.04);
  }
  ctx.restore();
}

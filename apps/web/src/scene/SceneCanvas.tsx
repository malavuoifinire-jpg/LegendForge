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
import type { LightSource, SceneVisionState } from '@legendforge/contracts';
import type { CanvasMap, CanvasToken } from './types';
import {
  drawDraftWall,
  drawFog,
  drawLights,
  drawSightEdges,
  drawWalls,
} from './visionLayers';
import {
  cellVectorToImagePoint,
  distanceToSegment,
  imagePointToCellVector,
  pixelsPerMeter,
} from '@legendforge/core';

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
   * Quali pedine chi guarda può muovere. Le altre si possono selezionare per
   * leggerne i dati, ma non trascinare: lo deciderebbe comunque il server, e
   * lasciarle scivolare sotto il dito sarebbe una bugia.
   */
  canMoveToken?: (id: string) => boolean;
  /**
   * Modalità di raccolta punti per la calibrazione: il clic indica un incrocio
   * invece di selezionare una pedina.
   */
  picking?: boolean;
  onPickPoint?: (point: ImagePoint) => void;
  /** Punti già raccolti, disegnati come riferimento. */
  pickedPoints?: ImagePoint[];

  /* -------------------------------- visione ------------------------------- */

  /** Che cosa si vede, come l'ha calcolato il server. */
  vision?: SceneVisionState | null;
  /**
   * Strumento attivo. `wall` e `light` sono del Game Master: il clic smette di
   * selezionare pedine e diventa un gesto di disegno.
   */
  tool?: 'select' | 'wall' | 'light';
  /** Vertici della spezzata in corso di disegno. */
  draftWall?: ImagePoint[];
  selectedWallId?: string | null;
  selectedLightId?: string | null;
  /** Aggancia i vertici dei muri agli angoli della griglia. */
  snapWalls?: boolean;
  onWallPoint?: (point: ImagePoint) => void;
  onSelectWall?: (id: string | null) => void;
  onSelectLight?: (id: string | null) => void;
  onPlaceLight?: (point: ImagePoint) => void;
}

/**
 * Aggancia un punto all'angolo di griglia più vicino.
 *
 * I muri corrono lungo i bordi delle stanze, che sui più delle mappe cadono
 * sugli angoli delle caselle: agganciare evita spifferi di un pixel fra due
 * segmenti che dovrebbero toccarsi.
 */
function snapToCorner(point: ImagePoint, grid: GridConfiguration): ImagePoint {
  const vector = imagePointToCellVector(point, grid);
  return cellVectorToImagePoint(
    { col: Math.round(vector.col), row: Math.round(vector.row) },
    grid,
  );
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
  canMoveToken,
  picking = false,
  onPickPoint,
  pickedPoints,
  vision = null,
  tool = 'select',
  draftWall,
  selectedWallId = null,
  selectedLightId = null,
  snapWalls = true,
  onWallPoint,
  onSelectWall,
  onSelectLight,
  onPlaceLight,
}: SceneCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionRef = useRef<Interaction>({ kind: 'none' });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [cursor, setCursor] = useState<ImagePoint | null>(null);
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

    // Luci sotto al buio: quello che illuminano si vede attraverso i ritagli.
    if (vision?.lights && vision.lights.length > 0) {
      const positions = new Map(tokens.map((token) => [token.id, { x: token.x, y: token.y }]));
      drawLights(ctx, vision.lights, positions, pixelsPerMeter(grid), viewport, selectedLightId);
    }

    // Buio e campo visivo: solo quando si guarda con gli occhi di una pedina.
    // Il Game Master, che vede tutto, non deve guardare attraverso un velo.
    if (vision && vision.visionEnabled && vision.perspective === 'tokens') {
      drawFog(ctx, vision, viewport, size, {
        x: origin.x,
        y: origin.y,
        width: map.width * viewport.zoom,
        height: map.height * viewport.zoom,
      });
      drawSightEdges(ctx, vision, viewport);
    }

    // Muri: li riceve solo il Game Master, e li disegna sopra al resto perché
    // è la cosa che sta modificando.
    if (vision?.walls) drawWalls(ctx, vision.walls, viewport, selectedWallId);
    // Al giocatore non arrivano i muri, ma le porte che ha davanti sì: senza
    // vederle non potrebbe aprirle.
    else if (vision) drawWalls(ctx, vision.visibleDoors, viewport, selectedWallId);
    if (draftWall && draftWall.length > 0) {
      drawDraftWall(ctx, draftWall, tool === 'wall' ? cursor : null, viewport);
    }

    // Pedine
    for (const token of tokens) {
      drawToken(ctx, token, grid, viewport, token.id === selectedTokenId);
    }

    // Punti raccolti per la calibrazione
    for (const [index, point] of (pickedPoints ?? []).entries()) {
      drawPickedPoint(ctx, point, viewport, index + 1);
    }
  }, [
    map,
    grid,
    gridVisible,
    tokens,
    selectedTokenId,
    viewport,
    size,
    pickedPoints,
    vision,
    draftWall,
    selectedWallId,
    selectedLightId,
    tool,
    cursor,
  ]);

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

  /** Muro più vicino al punto, entro una soglia che non dipende dallo zoom. */
  const wallAtPoint = useCallback(
    (point: ImagePoint): string | null => {
      const walls = vision?.walls ?? vision?.visibleDoors;
      if (!walls || walls.length === 0) return null;
      const tolerance = 8 / viewport.zoom;
      let best: { id: string; distance: number } | null = null;
      for (const wall of walls) {
        const distance = distanceToSegment(
          point,
          { x: wall.ax, y: wall.ay },
          { x: wall.bx, y: wall.by },
        );
        if (distance <= tolerance && (!best || distance < best.distance)) {
          best = { id: wall.id, distance };
        }
      }
      return best ? best.id : null;
    },
    [vision, viewport.zoom],
  );

  const lightAtPoint = useCallback(
    (point: ImagePoint): LightSource | null => {
      const lights = vision?.lights;
      if (!lights) return null;
      const tolerance = 10 / viewport.zoom;
      for (const light of lights) {
        const anchor = light.tokenId
          ? tokens.find((token) => token.id === light.tokenId)
          : undefined;
        const x = anchor ? anchor.x : light.x;
        const y = anchor ? anchor.y : light.y;
        if (Math.hypot(point.x - x, point.y - y) <= tolerance) return light;
      }
      return null;
    },
    [vision, viewport.zoom, tokens],
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

      if (event.button === 0 && tool === 'wall') {
        onWallPoint?.(snapWalls ? snapToCorner(image, grid) : image);
        return;
      }

      if (event.button === 0 && tool === 'light') {
        onPlaceLight?.(image);
        return;
      }

      const token = tokenAtPoint(image);

      // Con lo strumento di selezione, muri e luci si prendono solo se non c'è
      // una pedina sotto al dito: le pedine restano la cosa che si tocca di più.
      if (event.button === 0 && !token && vision) {
        const light = lightAtPoint(image);
        if (light) {
          onSelectLight?.(light.id);
          onSelectWall?.(null);
          return;
        }
        const wall = wallAtPoint(image);
        if (wall) {
          onSelectWall?.(wall);
          onSelectLight?.(null);
          return;
        }
        onSelectWall?.(null);
        onSelectLight?.(null);
      }

      if (token && event.button === 0) {
        onSelectToken(token.id);
        if (!canMoveToken || canMoveToken(token.id)) {
          interactionRef.current = {
            kind: 'token',
            id: token.id,
            grabOffsetX: image.x - token.x,
            grabOffsetY: image.y - token.y,
          };
          return;
        }
        // Pedina non controllabile: il gesto diventa uno spostamento della vista.
      }

      if (event.button === 0) onSelectToken(null);
      interactionRef.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
    },
    [
      viewport,
      tokenAtPoint,
      onSelectToken,
      picking,
      onPickPoint,
      canMoveToken,
      tool,
      snapWalls,
      grid,
      vision,
      wallAtPoint,
      lightAtPoint,
      onWallPoint,
      onPlaceLight,
      onSelectWall,
      onSelectLight,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const image = screenToImage(screen, viewport);
      onHoverCell?.(imagePointToCell(image, grid));
      if (tool === 'wall') setCursor(snapWalls ? snapToCorner(image, grid) : image);

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
    [viewport, grid, onHoverCell, onMoveToken, tool, snapWalls],
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

/**
 * Sigla mostrata dentro la pedina.
 *
 * Due lettere iniziali non bastano: "Pedina 1" e "Pedina 2" darebbero la
 * stessa sigla. Quando il nome finisce con un numero, quello è il dato che
 * distingue; altrimenti si usano le iniziali delle prime due parole.
 */
function shortLabel(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 1 && last && /^\d{1,2}$/u.test(last)) {
    return `${(words[0] ?? '').charAt(0).toUpperCase()}${last}`;
  }
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join('');
  }
  return name.slice(0, 2).toUpperCase();
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

  const label = shortLabel(token.name);
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

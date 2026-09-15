import type { ImagePoint, ScreenPoint } from './types.js';

/**
 * Trasformazione di vista del canvas.
 *
 * Zoom e pan agiscono soltanto qui: le coordinate logiche della scena non
 * vengono mai modificate da una navigazione della vista.
 */
export interface Viewport {
  panX: number;
  panY: number;
  /** 1 = un pixel immagine per un pixel schermo. */
  zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 12;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function imageToScreen(p: ImagePoint, vp: Viewport): ScreenPoint {
  return { x: p.x * vp.zoom + vp.panX, y: p.y * vp.zoom + vp.panY };
}

export function screenToImage(s: ScreenPoint, vp: Viewport): ImagePoint {
  return { x: (s.x - vp.panX) / vp.zoom, y: (s.y - vp.panY) / vp.zoom };
}

/** Zoom mantenendo fermo il punto immagine che si trova sotto `anchor`. */
export function zoomAt(vp: Viewport, anchor: ScreenPoint, factor: number): Viewport {
  const nextZoom = clampZoom(vp.zoom * factor);
  if (nextZoom === vp.zoom) return vp;
  const imageAnchor = screenToImage(anchor, vp);
  return {
    zoom: nextZoom,
    panX: anchor.x - imageAnchor.x * nextZoom,
    panY: anchor.y - imageAnchor.y * nextZoom,
  };
}

export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, panX: vp.panX + dxScreen, panY: vp.panY + dyScreen };
}

/** Vista che inquadra completamente un'immagine dentro un canvas. */
export function fitToViewport(
  image: { width: number; height: number },
  canvas: { width: number; height: number },
  padding = 24,
): Viewport {
  const availableWidth = Math.max(1, canvas.width - padding * 2);
  const availableHeight = Math.max(1, canvas.height - padding * 2);
  const zoom = clampZoom(Math.min(availableWidth / image.width, availableHeight / image.height));
  return {
    zoom,
    panX: (canvas.width - image.width * zoom) / 2,
    panY: (canvas.height - image.height * zoom) / 2,
  };
}

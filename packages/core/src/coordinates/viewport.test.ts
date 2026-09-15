import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitToViewport,
  imageToScreen,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  screenToImage,
  zoomAt,
  type Viewport,
} from './viewport.js';
import { imagePointToCell, type GridConfiguration } from './grid.js';

const vp: Viewport = { panX: 120, panY: -40, zoom: 1.75 };
const grid: GridConfiguration = {
  cellSizePx: 96,
  offsetX: 13,
  offsetY: 7,
  rotationDeg: 1.2,
  metersPerCell: 1.5,
  snapEnabled: true,
};

describe('trasformazione di vista', () => {
  it('schermo e immagine sono reciproci', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 512.25, y: 1024.75 },
      { x: -300, y: 88 },
    ]) {
      const back = screenToImage(imageToScreen(p, vp), vp);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('zoom e pan non alterano le coordinate logiche della scena', () => {
    const scenePoint = { x: 641.5, y: 388.25 };
    const cellBefore = imagePointToCell(scenePoint, grid);
    let view = vp;
    view = zoomAt(view, { x: 400, y: 300 }, 1.4);
    view = panBy(view, -260, 95);
    view = zoomAt(view, { x: 120, y: 700 }, 0.6);
    const roundTrip = screenToImage(imageToScreen(scenePoint, view), view);
    expect(roundTrip.x).toBeCloseTo(scenePoint.x, 9);
    expect(roundTrip.y).toBeCloseTo(scenePoint.y, 9);
    expect(imagePointToCell(roundTrip, grid)).toEqual(cellBefore);
  });

  it('lo zoom mantiene fermo il punto sotto il cursore', () => {
    const anchor = { x: 333, y: 222 };
    const imageAnchor = screenToImage(anchor, vp);
    const after = imageToScreen(imageAnchor, zoomAt(vp, anchor, 2.3));
    expect(after.x).toBeCloseTo(anchor.x, 9);
    expect(after.y).toBeCloseTo(anchor.y, 9);
  });

  it('limita lo zoom entro i valori consentiti', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(zoomAt({ panX: 0, panY: 0, zoom: MAX_ZOOM }, { x: 0, y: 0 }, 2).zoom).toBe(MAX_ZOOM);
  });

  it('fitToViewport inquadra l intera immagine', () => {
    const fitted = fitToViewport({ width: 2000, height: 1000 }, { width: 800, height: 600 }, 20);
    expect(fitted.zoom).toBeCloseTo(760 / 2000, 10);
    const bottomRight = imageToScreen({ x: 2000, y: 1000 }, fitted);
    expect(bottomRight.x).toBeLessThanOrEqual(780.1);
    expect(bottomRight.y).toBeLessThanOrEqual(600);
  });
});

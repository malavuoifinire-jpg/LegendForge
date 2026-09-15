import type { GrayImage } from './detector.js';

export interface SyntheticGridOptions {
  width: number;
  height: number;
  cellSizePx: number;
  offsetX: number;
  offsetY: number;
  rotationDeg?: number;
  lineWidthPx?: number;
  background?: number;
  lineValue?: number;
  /** Ampiezza del rumore uniforme aggiunto allo sfondo. */
  noise?: number;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genera una mappa sintetica con una griglia nota.
 *
 * Serve a verificare il rilevatore senza dipendere da immagini reali, quindi
 * senza introdurre materiale di terze parti nel repository.
 */
export function makeSyntheticGrid(options: SyntheticGridOptions): GrayImage {
  const {
    width,
    height,
    cellSizePx,
    offsetX,
    offsetY,
    rotationDeg = 0,
    lineWidthPx = 1.2,
    background = 205,
    lineValue = 55,
    noise = 0,
    seed = 42,
  } = options;

  const random = mulberry32(seed);
  const data = new Uint8Array(width * height);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const half = lineWidthPx / 2;
  const uOrigin = offsetX * cos + offsetY * sin;
  const vOrigin = -offsetX * sin + offsetY * cos;

  const distanceToLine = (value: number, origin: number): number => {
    const modulo = (((value - origin) % cellSizePx) + cellSizePx) % cellSizePx;
    return Math.min(modulo, cellSizePx - modulo);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      const onLine = distanceToLine(u, uOrigin) <= half || distanceToLine(v, vOrigin) <= half;
      let value = onLine ? lineValue : background;
      if (noise > 0) value += (random() - 0.5) * 2 * noise;
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }

  return { data, width, height };
}

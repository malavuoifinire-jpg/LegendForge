import { detectGrid, type DetectGridResult } from '@legendforge/core';
import type { GridDetection } from '@legendforge/contracts';

/**
 * Rilevamento della griglia nel browser.
 *
 * L'immagine è già decodificata qui: analizzarla dove si trova evita di
 * spedirla due volte e di installare una libreria di decodifica dentro una
 * funzione serverless. Il risultato è comunque una proposta, che il server
 * valida e il Game Master conferma.
 */

/** Oltre questa dimensione l'analisi lavora su una copia ridotta. */
const MAX_ANALYSIS_DIMENSION = 1400;

export interface LoadedImage {
  element: HTMLImageElement;
  width: number;
  height: number;
  objectUrl: string;
}

export function loadImageFromFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => {
      resolve({ element, width: element.naturalWidth, height: element.naturalHeight, objectUrl });
    };
    element.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Il file non è un'immagine leggibile"));
    };
    element.src = objectUrl;
  });
}

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Impossibile caricare l'immagine della mappa"));
    element.src = url;
  });
}

/** Converte l'immagine in scala di grigi, riducendola se necessario. */
function toGrayscale(image: HTMLImageElement): {
  data: Uint8Array;
  width: number;
  height: number;
  scale: number;
} | null {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const ratio = longest > MAX_ANALYSIS_DIMENSION ? MAX_ANALYSIS_DIMENSION / longest : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    // Un'immagine di origine diversa senza CORS non è leggibile pixel per pixel.
    return null;
  }

  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    // Luminanza percettiva: i bordi di una griglia disegnata restano netti.
    gray[i] = (0.299 * (pixels[p] ?? 0) + 0.587 * (pixels[p + 1] ?? 0) + 0.114 * (pixels[p + 2] ?? 0)) | 0;
  }
  return { data: gray, width, height, scale: 1 / ratio };
}

export function detectGridInImage(image: HTMLImageElement): GridDetection | null {
  const started = performance.now();
  const gray = toGrayscale(image);
  if (!gray) return null;

  const result: DetectGridResult = detectGrid(
    { data: gray.data, width: gray.width, height: gray.height },
    { scale: gray.scale },
  );

  return {
    cellSizePx: result.cellSizePx,
    offsetX: result.offsetX,
    offsetY: result.offsetY,
    rotationDeg: result.rotationDeg,
    confidence: result.confidence,
    axisAgreement: result.axisAgreement,
    analyzedWidth: gray.width,
    analyzedHeight: gray.height,
    elapsedMs: Math.round(performance.now() - started),
  };
}

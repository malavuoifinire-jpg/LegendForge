import { detrend, estimatePeriod, profileConcentration, type Signal } from './signal.js';

/**
 * Rilevamento di una griglia quadrata ortogonale, con eventuale lieve
 * rotazione, a partire da un'immagine in scala di grigi.
 *
 * Non modifica mai l'immagine: produce una proposta con un livello di
 * confidenza. La conferma è sempre del Game Master.
 */

export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DetectGridOptions {
  /** Lato minimo plausibile della casella, in pixel dell'immagine analizzata. */
  minCellPx?: number;
  /** Lato massimo plausibile della casella, in pixel dell'immagine analizzata. */
  maxCellPx?: number;
  /** Ampiezza massima della rotazione cercata, in gradi. */
  maxRotationDeg?: number;
  /** Passo della ricerca di rotazione, in gradi. 0 la disattiva. */
  rotationStepDeg?: number;
  /** Fattore di scala fra immagine analizzata e immagine originale. */
  scale?: number;
}

export interface AxisDiagnostics {
  periodPx: number | null;
  phasePx: number | null;
  score: number;
}

export interface DetectGridResult {
  cellSizePx: number | null;
  offsetX: number | null;
  offsetY: number | null;
  rotationDeg: number | null;
  /** Confidenza complessiva in 0..1. */
  confidence: number;
  horizontal: AxisDiagnostics;
  vertical: AxisDiagnostics;
  /** Accordo fra i due assi, 0..1. */
  axisAgreement: number;
}

const DEFAULTS = {
  minCellPx: 16,
  maxCellPx: 320,
  maxRotationDeg: 4,
  rotationStepDeg: 0.5,
  scale: 1,
};

function gradientAt(image: GrayImage, x: number, y: number): { gx: number; gy: number } {
  const { data, width } = image;
  const idx = y * width + x;
  const left = data[idx - 1] ?? 0;
  const right = data[idx + 1] ?? 0;
  const up = data[idx - width] ?? 0;
  const down = data[idx + width] ?? 0;
  return { gx: Math.abs(right - left), gy: Math.abs(down - up) };
}

/**
 * Proietta l'energia dei bordi su due assi ruotati di `angleRad`.
 *
 * L'asse `u` accumula i gradienti orizzontali, cioè le linee verticali della
 * griglia; l'asse `v` quelli verticali.
 */
export function projectEdges(
  image: GrayImage,
  angleRad: number,
): { u: Signal; v: Signal; uOrigin: number; vOrigin: number } {
  const { width, height } = image;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const corner of [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ]) {
    const u = corner.x * cos + corner.y * sin;
    const v = -corner.x * sin + corner.y * cos;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  const uLength = Math.max(2, Math.ceil(uMax - uMin) + 1);
  const vLength = Math.max(2, Math.ceil(vMax - vMin) + 1);
  const u = new Float64Array(uLength);
  const v = new Float64Array(vLength);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const { gx, gy } = gradientAt(image, x, y);
      if (gx > 0) {
        const position = x * cos + y * sin - uMin;
        const i = Math.floor(position);
        const frac = position - i;
        if (i >= 0 && i + 1 < uLength) {
          u[i] = (u[i] ?? 0) + gx * (1 - frac);
          u[i + 1] = (u[i + 1] ?? 0) + gx * frac;
        }
      }
      if (gy > 0) {
        const position = -x * sin + y * cos - vMin;
        const j = Math.floor(position);
        const frac = position - j;
        if (j >= 0 && j + 1 < vLength) {
          v[j] = (v[j] ?? 0) + gy * (1 - frac);
          v[j + 1] = (v[j + 1] ?? 0) + gy * frac;
        }
      }
    }
  }

  return { u, v, uOrigin: uMin, vOrigin: vMin };
}

interface AxisProfiles {
  uSignal: Signal;
  vSignal: Signal;
  uOrigin: number;
  vOrigin: number;
  concentration: number;
}

function profilesAtAngle(image: GrayImage, angleDeg: number, detrendRadius: number): AxisProfiles {
  const { u, v, uOrigin, vOrigin } = projectEdges(image, (angleDeg * Math.PI) / 180);
  const uSignal = detrend(u, detrendRadius);
  const vSignal = detrend(v, detrendRadius);
  return {
    uSignal,
    vSignal,
    uOrigin,
    vOrigin,
    concentration: profileConcentration(uSignal) + profileConcentration(vSignal),
  };
}

/**
 * Cerca la rotazione che rende più nitido il profilo dei bordi.
 *
 * Il criterio è la concentrazione del profilo, non la periodicità: una griglia
 * ruotata, proiettata sugli assi dell'immagine, resta periodica ma con i picchi
 * spalmati, quindi la sola autocorrelazione non distinguerebbe i due casi.
 */
export function searchRotation(
  image: GrayImage,
  maxRotationDeg: number,
  stepDeg: number,
  detrendRadius: number,
): { angleDeg: number; profiles: AxisProfiles } {
  const baseline = profilesAtAngle(image, 0, detrendRadius);
  if (stepDeg <= 0 || maxRotationDeg <= 0) return { angleDeg: 0, profiles: baseline };

  let bestAngle = 0;
  let bestProfiles = baseline;
  let bestScore = baseline.concentration;

  const consider = (angle: number): void => {
    const profiles = profilesAtAngle(image, angle, detrendRadius);
    if (profiles.concentration > bestScore) {
      bestScore = profiles.concentration;
      bestAngle = angle;
      bestProfiles = profiles;
    }
  };

  for (let angle = -maxRotationDeg; angle <= maxRotationDeg + 1e-9; angle += stepDeg) {
    if (Math.abs(angle) < 1e-9) continue;
    consider(angle);
  }

  if (bestAngle !== 0) {
    const around = bestAngle;
    for (let angle = around - stepDeg; angle <= around + stepDeg + 1e-9; angle += stepDeg / 5) {
      if (Math.abs(angle - around) < 1e-9) continue;
      consider(angle);
    }
  }

  // Una rotazione si accetta solo se migliora il profilo in modo netto.
  if (bestScore <= baseline.concentration * 1.02) return { angleDeg: 0, profiles: baseline };
  return { angleDeg: bestAngle, profiles: bestProfiles };
}

/** Accordo fra i passi stimati sui due assi, 0..1. */
export function axisAgreement(a: number | null, b: number | null): number {
  if (a === null || b === null || a <= 0 || b <= 0) return 0;
  const ratio = Math.min(a, b) / Math.max(a, b);
  // Uno scarto del 5% fra gli assi porta l'accordo a zero.
  return Math.max(0, 1 - (1 - ratio) / 0.05);
}

export function detectGrid(image: GrayImage, options: DetectGridOptions = {}): DetectGridResult {
  const opts = { ...DEFAULTS, ...options };
  const empty: DetectGridResult = {
    cellSizePx: null,
    offsetX: null,
    offsetY: null,
    rotationDeg: null,
    confidence: 0,
    horizontal: { periodPx: null, phasePx: null, score: 0 },
    vertical: { periodPx: null, phasePx: null, score: 0 },
    axisAgreement: 0,
  };
  if (image.width < 32 || image.height < 32) return empty;

  const maxCellPx = Math.min(opts.maxCellPx, Math.floor(Math.min(image.width, image.height) / 3));
  if (maxCellPx <= opts.minCellPx) return empty;

  const detrendRadius = Math.max(4, Math.round(maxCellPx / 2));
  const { angleDeg, profiles } = searchRotation(
    image,
    opts.maxRotationDeg,
    opts.rotationStepDeg,
    detrendRadius,
  );

  const search = { minPeriod: opts.minCellPx, maxPeriod: maxCellPx, coarseStep: 1 };
  const uEstimate = estimatePeriod(profiles.uSignal, search);
  const vEstimate = estimatePeriod(profiles.vSignal, search);

  const agreement = axisAgreement(uEstimate.period, vEstimate.period);
  const horizontal: AxisDiagnostics = {
    periodPx: uEstimate.period === null ? null : uEstimate.period * opts.scale,
    phasePx: uEstimate.phase === null ? null : uEstimate.phase * opts.scale,
    score: uEstimate.score,
  };
  const vertical: AxisDiagnostics = {
    periodPx: vEstimate.period === null ? null : vEstimate.period * opts.scale,
    phasePx: vEstimate.phase === null ? null : vEstimate.phase * opts.scale,
    score: vEstimate.score,
  };

  if (uEstimate.period === null || vEstimate.period === null || agreement === 0) {
    return { ...empty, rotationDeg: angleDeg, horizontal, vertical, axisAgreement: agreement };
  }

  const uPeriod = uEstimate.period;
  const vPeriod = vEstimate.period;
  const totalScore = uEstimate.score + vEstimate.score;
  const cellAnalysis =
    totalScore > 0
      ? (uPeriod * uEstimate.score + vPeriod * vEstimate.score) / totalScore
      : (uPeriod + vPeriod) / 2;

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // La fase è misurata nello spazio proiettato: va riportata in coordinate
  // immagine e ricondotta alla prima cella positiva.
  const wrap = (value: number, period: number): number => {
    const wrapped = value % period;
    return wrapped < 0 ? wrapped + period : wrapped;
  };
  const u0 = wrap((uEstimate.phase ?? 0) + profiles.uOrigin, uPeriod);
  const v0 = wrap((vEstimate.phase ?? 0) + profiles.vOrigin, vPeriod);

  const sharpness = Math.min(1, (uEstimate.contrast + vEstimate.contrast) / 2 + 0.25);
  const confidence = Math.max(
    0,
    Math.min(1, Math.min(uEstimate.score, vEstimate.score) * agreement * sharpness),
  );

  return {
    cellSizePx: Number((cellAnalysis * opts.scale).toFixed(4)),
    offsetX: Number(((u0 * cos - v0 * sin) * opts.scale).toFixed(4)),
    offsetY: Number(((u0 * sin + v0 * cos) * opts.scale).toFixed(4)),
    rotationDeg: Number(angleDeg.toFixed(3)),
    confidence: Number(confidence.toFixed(4)),
    horizontal,
    vertical,
    axisAgreement: Number(agreement.toFixed(4)),
  };
}

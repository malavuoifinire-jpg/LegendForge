/**
 * Primitive di analisi del segnale usate dal rilevamento della griglia.
 *
 * Sono funzioni pure su array numerici: si verificano con segnali sintetici,
 * senza decodificare immagini.
 */

export type Signal = Float64Array;

function at(signal: Signal, index: number): number {
  return signal[index] ?? 0;
}

/** Campionamento lineare; fuori intervallo vale zero. */
export function sampleLinear(signal: Signal, position: number): number {
  if (position < 0 || position > signal.length - 1) return 0;
  const i = Math.floor(position);
  const frac = position - i;
  if (frac === 0) return at(signal, i);
  return at(signal, i) * (1 - frac) + at(signal, i + 1) * frac;
}

/**
 * Rimuove la componente lenta del segnale — illuminazione, texture della mappa —
 * sottraendo una media mobile e azzerando i valori negativi.
 */
export function detrend(signal: Signal, windowRadius: number): Signal {
  const n = signal.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const radius = Math.max(1, Math.min(windowRadius, Math.floor(n / 2)));

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = (prefix[i] ?? 0) + at(signal, i);

  for (let i = 0; i < n; i += 1) {
    const from = Math.max(0, i - radius);
    const to = Math.min(n, i + radius + 1);
    const mean = ((prefix[to] ?? 0) - (prefix[from] ?? 0)) / (to - from);
    const value = at(signal, i) - mean;
    out[i] = value > 0 ? value : 0;
  }
  return out;
}

export interface CombScore {
  onMean: number;
  offMean: number;
  /** Contrasto normalizzato in 0..1. */
  contrast: number;
  /** Fase migliore, in [0, periodo). */
  phase: number;
  teeth: number;
}

/**
 * Quanto un segnale assomiglia a picchi equispaziati di periodo `period`,
 * cercando la fase migliore.
 */
export function scoreComb(signal: Signal, period: number, phaseSteps = 0): CombScore {
  const n = signal.length;
  const empty: CombScore = { onMean: 0, offMean: 0, contrast: 0, phase: 0, teeth: 0 };
  if (period <= 1 || n < period * 2) return empty;

  const steps = phaseSteps > 0 ? phaseSteps : Math.max(8, Math.round(period));
  let best = empty;

  for (let s = 0; s < steps; s += 1) {
    const phase = (s / steps) * period;
    let on = 0;
    let off = 0;
    let teeth = 0;
    for (let position = phase; position <= n - 1; position += period) {
      // Il picco può cadere fra due campioni: si prende il massimo locale.
      on += Math.max(
        sampleLinear(signal, position - 0.5),
        sampleLinear(signal, position),
        sampleLinear(signal, position + 0.5),
      );
      off += sampleLinear(signal, position + period / 2);
      teeth += 1;
    }
    if (teeth < 3) continue;
    const onMean = on / teeth;
    const offMean = off / teeth;
    const denominator = onMean + offMean;
    const contrast = denominator > 1e-9 ? (onMean - offMean) / denominator : 0;
    if (contrast > best.contrast) {
      best = { onMean, offMean, contrast: Math.max(0, contrast), phase, teeth };
    }
  }
  return best;
}

/**
 * Concentrazione del profilo: quanto l'energia dei bordi è raccolta in pochi
 * campioni invece di essere spalmata. Vale 1 per un profilo piatto e cresce con
 * la nitidezza dei picchi. È invariante rispetto a scala e lunghezza, quindi
 * confrontabile fra proiezioni prese ad angoli diversi.
 */
export function profileConcentration(signal: Signal): number {
  const n = signal.length;
  if (n === 0) return 0;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i += 1) {
    const value = at(signal, i);
    sum += value;
    sumSquares += value * value;
  }
  if (sum <= 1e-9) return 0;
  return (n * sumSquares) / (sum * sum);
}

/**
 * Fase dei picchi per un periodo noto, dalla componente fondamentale di
 * Fourier: stima continua, non soggetta alla quantizzazione di una ricerca a
 * passi discreti.
 */
export function estimatePhase(signal: Signal, period: number): number {
  const n = signal.length;
  if (period <= 1 || n < period * 2) return 0;
  // Un numero intero di periodi evita la dispersione spettrale.
  const usable = Math.floor(n / period) * period;
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < usable; i += 1) {
    const angle = (2 * Math.PI * i) / period;
    const value = at(signal, i);
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  if (Math.abs(real) < 1e-12 && Math.abs(imaginary) < 1e-12) return 0;
  const phase = (Math.atan2(imaginary, real) * period) / (2 * Math.PI);
  const wrapped = phase % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/**
 * Correlazione di Pearson fra il segnale e se stesso traslato di `lag`.
 *
 * A differenza di un prodotto scalare, la rimozione della media porta il
 * risultato vicino a zero per segnali non periodici — rumore, texture — e
 * vicino a uno per un reticolo regolare.
 */
export function autocorrelation(signal: Signal, lag: number): number {
  const n = signal.length;
  const overlap = Math.floor(n - lag);
  if (lag <= 0 || overlap < 8) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < overlap; i += 1) {
    sumA += at(signal, i);
    sumB += sampleLinear(signal, i + lag);
  }
  const meanA = sumA / overlap;
  const meanB = sumB / overlap;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < overlap; i += 1) {
    const a = at(signal, i) - meanA;
    const b = sampleLinear(signal, i + lag) - meanB;
    covariance += a * b;
    varianceA += a * a;
    varianceB += b * b;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  if (denominator < 1e-9) return 0;
  return covariance / denominator;
}

export interface PeriodEstimate {
  period: number | null;
  phase: number | null;
  /** Correlazione normalizzata 0..1 del periodo scelto. */
  score: number;
  /** Contrasto del pettine alla fase scelta, 0..1. */
  contrast: number;
}

export interface PeriodSearchOptions {
  minPeriod: number;
  maxPeriod: number;
  coarseStep?: number;
  /** Frazione della correlazione migliore accettata per preferire il periodo minore. */
  harmonicTolerance?: number;
}

/**
 * Stima periodo e fase.
 *
 * Il periodo viene scelto per autocorrelazione; fra periodi con correlazione
 * quasi equivalente si preferisce il più piccolo, per non agganciare un
 * multiplo del passo reale. La fase arriva poi dalla componente fondamentale.
 */
export function estimatePeriod(signal: Signal, options: PeriodSearchOptions): PeriodEstimate {
  const empty: PeriodEstimate = { period: null, phase: null, score: 0, contrast: 0 };
  const coarseStep = options.coarseStep ?? 1;
  const harmonicTolerance = options.harmonicTolerance ?? 0.92;
  const upper = Math.min(options.maxPeriod, signal.length / 3);
  if (upper < options.minPeriod) return empty;

  const candidates: { period: number; correlation: number }[] = [];
  let bestCorrelation = 0;
  for (let p = options.minPeriod; p <= upper; p += coarseStep) {
    const correlation = autocorrelation(signal, p);
    candidates.push({ period: p, correlation });
    if (correlation > bestCorrelation) bestCorrelation = correlation;
  }
  if (candidates.length === 0 || bestCorrelation <= 0.05) return empty;

  // Il primo massimo locale che raggiunge la soglia è il passo fondamentale.
  const threshold = bestCorrelation * harmonicTolerance;
  let chosen = candidates.reduce((a, b) => (b.correlation > a.correlation ? b : a));
  for (let i = 0; i < candidates.length; i += 1) {
    const current = candidates[i];
    if (!current || current.correlation < threshold) continue;
    const previous = candidates[i - 1];
    const next = candidates[i + 1];
    const isLocalMax =
      (!previous || current.correlation >= previous.correlation) &&
      (!next || current.correlation >= next.correlation);
    if (isLocalMax) {
      chosen = current;
      break;
    }
  }

  let bestPeriod = chosen.period;
  let bestScore = chosen.correlation;
  const radius = Math.max(coarseStep, 1);
  for (let p = chosen.period - radius; p <= chosen.period + radius; p += 0.05) {
    if (p < options.minPeriod || p > upper) continue;
    const correlation = autocorrelation(signal, p);
    if (correlation > bestScore) {
      bestScore = correlation;
      bestPeriod = p;
    }
  }

  const comb = scoreComb(signal, bestPeriod, Math.max(16, Math.round(bestPeriod * 2)));
  return {
    period: Number(bestPeriod.toFixed(4)),
    phase: Number(estimatePhase(signal, bestPeriod).toFixed(4)),
    score: Number(Math.max(0, Math.min(1, bestScore)).toFixed(6)),
    contrast: Number(comb.contrast.toFixed(6)),
  };
}

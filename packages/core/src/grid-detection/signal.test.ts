import { describe, expect, it } from 'vitest';
import {
  autocorrelation,
  detrend,
  estimatePeriod,
  estimatePhase,
  profileConcentration,
  sampleLinear,
} from './signal.js';

function peaks(length: number, period: number, phase: number, amplitude = 1): Float64Array {
  const signal = new Float64Array(length);
  for (let position = phase; position < length; position += period) {
    signal[Math.round(position)] = amplitude;
  }
  return signal;
}

describe('campionamento e detrend', () => {
  it('interpola fra due campioni', () => {
    const signal = Float64Array.from([0, 10, 20]);
    expect(sampleLinear(signal, 0.5)).toBeCloseTo(5, 10);
    expect(sampleLinear(signal, 1.25)).toBeCloseTo(12.5, 10);
  });

  it('fuori intervallo vale zero', () => {
    const signal = Float64Array.from([1, 2, 3]);
    expect(sampleLinear(signal, -1)).toBe(0);
    expect(sampleLinear(signal, 9)).toBe(0);
  });

  it('rimuove una componente costante e tiene i picchi', () => {
    const signal = new Float64Array(200).fill(50);
    signal[100] = 200;
    const out = detrend(signal, 20);
    expect(out[0]).toBe(0);
    expect(out[100]).toBeGreaterThan(100);
  });
});

describe('autocorrelazione', () => {
  it('è alta al periodo reale e bassa altrove', () => {
    const signal = peaks(600, 50, 10);
    expect(autocorrelation(signal, 50)).toBeGreaterThan(0.9);
    expect(autocorrelation(signal, 37)).toBeLessThan(0.2);
  });

  it('è vicina a zero su rumore non periodico', () => {
    const signal = new Float64Array(600);
    let state = 7;
    for (let i = 0; i < signal.length; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      signal[i] = (state >> 9) % 100;
    }
    expect(Math.abs(autocorrelation(signal, 50))).toBeLessThan(0.2);
  });
});

describe('fase e concentrazione', () => {
  it('ritrova la fase di un treno di picchi', () => {
    const signal = peaks(600, 60, 17);
    const phase = estimatePhase(signal, 60);
    const error = Math.min(Math.abs(phase - 17), 60 - Math.abs(phase - 17));
    expect(error).toBeLessThan(1.5);
  });

  it('un profilo piatto ha concentrazione 1', () => {
    expect(profileConcentration(new Float64Array(100).fill(3))).toBeCloseTo(1, 6);
  });

  it('picchi netti hanno concentrazione alta', () => {
    expect(profileConcentration(peaks(600, 50, 0))).toBeGreaterThan(10);
  });
});

describe('stima del periodo', () => {
  it('trova il periodo fondamentale e non un multiplo', () => {
    const estimate = estimatePeriod(peaks(900, 45, 12), { minPeriod: 16, maxPeriod: 200 });
    expect(estimate.period).not.toBeNull();
    expect(estimate.period!).toBeCloseTo(45, 0);
  });

  it('restituisce nulla quando non c è periodicità', () => {
    const estimate = estimatePeriod(new Float64Array(600), { minPeriod: 16, maxPeriod: 200 });
    expect(estimate.period).toBeNull();
  });
});

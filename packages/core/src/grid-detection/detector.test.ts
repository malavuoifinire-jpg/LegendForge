import { describe, expect, it } from 'vitest';
import { axisAgreement, detectGrid } from './detector.js';
import { makeSyntheticGrid } from './synthetic.js';

function offsetError(actual: number, expected: number, period: number): number {
  const diff = (((actual - expected) % period) + period) % period;
  return Math.min(diff, period - diff);
}

describe('rilevamento della griglia', () => {
  it('riconosce una griglia pulita allineata agli assi', () => {
    const image = makeSyntheticGrid({
      width: 640,
      height: 480,
      cellSizePx: 64,
      offsetX: 17,
      offsetY: 9,
    });
    const result = detectGrid(image, { rotationStepDeg: 0 });
    expect(result.cellSizePx).not.toBeNull();
    expect(result.cellSizePx!).toBeCloseTo(64, 0);
    expect(offsetError(result.offsetX!, 17, 64)).toBeLessThan(1.5);
    expect(offsetError(result.offsetY!, 9, 64)).toBeLessThan(1.5);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('non aggancia un multiplo del passo reale', () => {
    const image = makeSyntheticGrid({
      width: 800,
      height: 800,
      cellSizePx: 40,
      offsetX: 5,
      offsetY: 31,
    });
    const result = detectGrid(image, { rotationStepDeg: 0 });
    expect(result.cellSizePx!).toBeGreaterThan(38);
    expect(result.cellSizePx!).toBeLessThan(42);
  });

  it('resiste al rumore di fondo', () => {
    const image = makeSyntheticGrid({
      width: 700,
      height: 520,
      cellSizePx: 52,
      offsetX: 23,
      offsetY: 41,
      noise: 26,
      seed: 7,
    });
    const result = detectGrid(image, { rotationStepDeg: 0 });
    expect(result.cellSizePx!).toBeCloseTo(52, 0);
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('stima una lieve rotazione', () => {
    const image = makeSyntheticGrid({
      width: 640,
      height: 640,
      cellSizePx: 60,
      offsetX: 12,
      offsetY: 20,
      rotationDeg: 2,
      lineWidthPx: 1.6,
    });
    const result = detectGrid(image, { maxRotationDeg: 4, rotationStepDeg: 0.5 });
    expect(result.rotationDeg).not.toBeNull();
    expect(Math.abs(result.rotationDeg! - 2)).toBeLessThanOrEqual(1);
    expect(result.cellSizePx!).toBeCloseTo(60, 0);
  });

  it('riporta confidenza bassa su un immagine senza griglia', () => {
    const width = 512;
    const height = 512;
    const data = new Uint8Array(width * height);
    let state = 12345;
    for (let i = 0; i < data.length; i += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      data[i] = 120 + ((state >> 7) % 60);
    }
    const result = detectGrid({ data, width, height }, { rotationStepDeg: 0 });
    expect(result.confidence).toBeLessThan(0.45);
  });

  it('riporta la scala all immagine originale', () => {
    const image = makeSyntheticGrid({
      width: 600,
      height: 600,
      cellSizePx: 50,
      offsetX: 10,
      offsetY: 10,
    });
    const result = detectGrid(image, { rotationStepDeg: 0, scale: 2 });
    expect(result.cellSizePx!).toBeCloseTo(100, 0);
  });

  it('rifiuta immagini troppo piccole', () => {
    const result = detectGrid({ data: new Uint8Array(16), width: 4, height: 4 });
    expect(result.confidence).toBe(0);
    expect(result.cellSizePx).toBeNull();
  });
});

describe('accordo fra assi', () => {
  it('vale 1 quando i passi coincidono', () => {
    expect(axisAgreement(64, 64)).toBe(1);
  });
  it('si annulla oltre il 5% di scarto', () => {
    expect(axisAgreement(64, 72)).toBe(0);
  });
  it('è nullo con valori mancanti', () => {
    expect(axisAgreement(null, 64)).toBe(0);
  });
});

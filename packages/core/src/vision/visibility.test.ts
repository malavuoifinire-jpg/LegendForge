import { describe, expect, it } from 'vitest';
import { computeVisibilityPolygon, polygonArea, polygonContains } from './visibility.js';
import type { WallSegment } from './types.js';

function wall(
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  kind: WallSegment['kind'] = 'opaque',
  doorState: WallSegment['doorState'] = 'closed',
): WallSegment {
  return { id, ax, ay, bx, by, kind, doorState };
}

/** Stanza quadrata di lato 200 con l'angolo in alto a sinistra in (0,0). */
function stanza(): WallSegment[] {
  return [
    wall('n', 0, 0, 200, 0),
    wall('e', 200, 0, 200, 200),
    wall('s', 200, 200, 0, 200),
    wall('o', 0, 200, 0, 0),
  ];
}

describe('poligono di visione', () => {
  it('senza muri disegna il cerchio della portata', () => {
    const poligono = computeVisibilityPolygon({ x: 0, y: 0 }, [], {
      radiusPx: 100,
      circleSegments: 180,
    });
    const area = polygonArea(poligono);
    const cerchio = Math.PI * 100 * 100;
    // Un poligono inscritto è un po' più piccolo del cerchio: basta che ci somigli.
    expect(area).toBeGreaterThan(cerchio * 0.98);
    expect(area).toBeLessThanOrEqual(cerchio);
  });

  it('dentro una stanza chiusa vede tutta la stanza e non oltre', () => {
    const centro = { x: 100, y: 100 };
    const poligono = computeVisibilityPolygon(centro, stanza(), { radiusPx: 1000 });
    const area = polygonArea(poligono);
    expect(area).toBeGreaterThan(200 * 200 * 0.99);
    expect(area).toBeLessThan(200 * 200 * 1.01);
    expect(polygonContains(poligono, { x: 190, y: 190 })).toBe(true);
    expect(polygonContains(poligono, { x: 260, y: 100 })).toBe(false);
  });

  it('un muro in mezzo riduce l area vista', () => {
    const centro = { x: 50, y: 100 };
    const libera = polygonArea(
      computeVisibilityPolygon(centro, stanza(), { radiusPx: 1000 }),
    );
    const divisa = polygonArea(
      computeVisibilityPolygon(centro, [...stanza(), wall('divisorio', 100, 0, 100, 200)], {
        radiusPx: 1000,
      }),
    );
    expect(divisa).toBeLessThan(libera * 0.55);
  });

  it('un punto dietro al muro resta fuori dal poligono', () => {
    const poligono = computeVisibilityPolygon(
      { x: 50, y: 100 },
      [...stanza(), wall('divisorio', 100, 0, 100, 200)],
      { radiusPx: 1000 },
    );
    expect(polygonContains(poligono, { x: 80, y: 100 })).toBe(true);
    expect(polygonContains(poligono, { x: 150, y: 100 })).toBe(false);
  });

  it('dietro lo spigolo non si vede, davanti allo spigolo sì', () => {
    // Muro che parte dal bordo nord e si ferma a metà stanza: lascia un varco.
    const spigolo = wall('spigolo', 100, 0, 100, 120);
    const poligono = computeVisibilityPolygon({ x: 50, y: 100 }, [...stanza(), spigolo], {
      radiusPx: 1000,
    });
    // Riparato dietro al muro, vicino al bordo nord.
    expect(polygonContains(poligono, { x: 140, y: 30 })).toBe(false);
    // Oltre la fine del muro, lo sguardo passa dal varco.
    expect(polygonContains(poligono, { x: 140, y: 170 })).toBe(true);
  });

  it('una porta aperta allarga il poligono, una chiusa no', () => {
    const centro = { x: 50, y: 100 };
    const parete = (stato: WallSegment['doorState']) => [
      ...stanza(),
      wall('muro-alto', 100, 0, 100, 80, 'opaque'),
      wall('porta', 100, 80, 100, 120, 'door', stato),
      wall('muro-basso', 100, 120, 100, 200, 'opaque'),
    ];
    const chiusa = polygonArea(computeVisibilityPolygon(centro, parete('closed'), { radiusPx: 1000 }));
    const aperta = polygonArea(computeVisibilityPolygon(centro, parete('open'), { radiusPx: 1000 }));
    const bloccata = polygonArea(
      computeVisibilityPolygon(centro, parete('locked'), { radiusPx: 1000 }),
    );
    expect(aperta).toBeGreaterThan(chiusa * 1.2);
    expect(bloccata).toBeCloseTo(chiusa, 6);

    const conPortaAperta = computeVisibilityPolygon(centro, parete('open'), { radiusPx: 1000 });
    const conPortaChiusa = computeVisibilityPolygon(centro, parete('closed'), { radiusPx: 1000 });
    expect(polygonContains(conPortaAperta, { x: 150, y: 100 })).toBe(true);
    expect(polygonContains(conPortaChiusa, { x: 150, y: 100 })).toBe(false);
  });

  it('una finestra lascia passare lo sguardo', () => {
    const centro = { x: 50, y: 100 };
    const conFinestra = computeVisibilityPolygon(
      centro,
      [...stanza(), wall('finestra', 100, 0, 100, 200, 'window')],
      { radiusPx: 1000 },
    );
    expect(polygonContains(conFinestra, { x: 150, y: 100 })).toBe(true);
  });

  it('una tenda ferma lo sguardo ma è un muro a parte', () => {
    const centro = { x: 50, y: 100 };
    const conTenda = computeVisibilityPolygon(
      centro,
      [...stanza(), wall('tenda', 100, 0, 100, 200, 'sight_blocker')],
      { radiusPx: 1000 },
    );
    expect(polygonContains(conTenda, { x: 150, y: 100 })).toBe(false);
  });

  it('i muri fuori portata non contano', () => {
    const vicino = polygonArea(
      computeVisibilityPolygon({ x: 0, y: 0 }, [wall('lontano', 500, -500, 500, 500)], {
        radiusPx: 100,
        circleSegments: 180,
      }),
    );
    const senzaMuri = polygonArea(
      computeVisibilityPolygon({ x: 0, y: 0 }, [], { radiusPx: 100, circleSegments: 180 }),
    );
    expect(vicino).toBeCloseTo(senzaMuri, 6);
  });

  it('la portata limita la vista anche in campo aperto', () => {
    const poligono = computeVisibilityPolygon({ x: 100, y: 100 }, stanza(), { radiusPx: 40 });
    expect(polygonContains(poligono, { x: 120, y: 100 })).toBe(true);
    expect(polygonContains(poligono, { x: 180, y: 100 })).toBe(false);
  });
});

describe('utilità sul poligono', () => {
  it('riconosce dentro e fuori su un quadrato', () => {
    const quadrato = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonContains(quadrato, { x: 5, y: 5 })).toBe(true);
    expect(polygonContains(quadrato, { x: 15, y: 5 })).toBe(false);
    expect(polygonArea(quadrato)).toBeCloseTo(100, 9);
  });

  it('un poligono degenere ha area zero', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBeCloseTo(0, 9);
    expect(polygonArea([])).toBe(0);
  });
});

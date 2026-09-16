import { describe, expect, it } from 'vitest';
import {
  canTraverse,
  distanceToSegment,
  firstMovementObstacle,
  hasLineOfSight,
  raySegmentHit,
  segmentIntersection,
} from './geometry.js';
import { blocksMovement, blocksSight, type WallSegment } from './types.js';

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

describe('incrocio fra raggio e muro', () => {
  it('trova il punto e la distanza', () => {
    const hit = raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: -5 }, { x: 10, y: 5 });
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(10, 9);
    expect(hit!.point.x).toBeCloseTo(10, 9);
    expect(hit!.point.y).toBeCloseTo(0, 9);
  });

  it('ignora ciò che sta alle spalle', () => {
    expect(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -10, y: -5 }, { x: -10, y: 5 })).toBeNull();
  });

  it('ignora i muri che il raggio manca', () => {
    expect(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 20 })).toBeNull();
  });

  it('ignora i muri paralleli al raggio', () => {
    expect(raySegmentHit({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 })).toBeNull();
  });

  it('trova l incrocio fra due segmenti e solo dentro i loro estremi', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }),
    ).toEqual({ x: 5, y: 0 });
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }),
    ).toBeNull();
  });

  it('misura la distanza da un segmento, anche oltre gli estremi', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 9);
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4, 9);
  });
});

describe('linea di vista', () => {
  const muro = [wall('w', 50, -100, 50, 100)];

  it('un muro in mezzo la interrompe', () => {
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, muro)).toBe(false);
  });

  it('senza nulla in mezzo è libera', () => {
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 40, y: 0 }, muro)).toBe(true);
  });

  it('si vede oltre il bordo del muro', () => {
    // Il muro finisce a y=100: mirando più in basso lo sguardo passa.
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 300 }, muro)).toBe(true);
  });

  it('una pedina appoggiata al muro vede lo stesso', () => {
    // Partenza esattamente sul muro: non deve bloccarsi da sola.
    expect(hasLineOfSight({ x: 50, y: 0 }, { x: 200, y: 0 }, muro)).toBe(true);
  });

  it('dietro un angolo non si vede', () => {
    const angolo = [wall('a', 0, 0, 100, 0), wall('b', 100, 0, 100, 100)];
    expect(hasLineOfSight({ x: 50, y: 50 }, { x: 150, y: 50 }, angolo)).toBe(false);
    expect(hasLineOfSight({ x: 50, y: 50 }, { x: 50, y: -50 }, angolo)).toBe(false);
    // Nella stessa stanza invece sì.
    expect(hasLineOfSight({ x: 20, y: 50 }, { x: 80, y: 80 }, angolo)).toBe(true);
  });
});

describe('porte', () => {
  const chiusa = [wall('d', 50, -100, 50, 100, 'door', 'closed')];
  const aperta = [wall('d', 50, -100, 50, 100, 'door', 'open')];
  const bloccata = [wall('d', 50, -100, 50, 100, 'door', 'locked')];

  it('chiusa ferma lo sguardo e il passo', () => {
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, chiusa)).toBe(false);
    expect(canTraverse({ x: 0, y: 0 }, { x: 100, y: 0 }, chiusa)).toBe(false);
  });

  it('aperta non ferma niente', () => {
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, aperta)).toBe(true);
    expect(canTraverse({ x: 0, y: 0 }, { x: 100, y: 0 }, aperta)).toBe(true);
  });

  it('bloccata si comporta come chiusa', () => {
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, bloccata)).toBe(false);
    expect(canTraverse({ x: 0, y: 0 }, { x: 100, y: 0 }, bloccata)).toBe(false);
  });
});

describe('vista e movimento sono indipendenti', () => {
  it('una finestra si vede ma non si attraversa', () => {
    const finestra = [wall('w', 50, -100, 50, 100, 'window')];
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, finestra)).toBe(true);
    expect(canTraverse({ x: 0, y: 0 }, { x: 100, y: 0 }, finestra)).toBe(false);
  });

  it('una tenda si attraversa ma non si vede attraverso', () => {
    const tenda = [wall('w', 50, -100, 50, 100, 'sight_blocker')];
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, tenda)).toBe(false);
    expect(canTraverse({ x: 0, y: 0 }, { x: 100, y: 0 }, tenda)).toBe(true);
  });

  it('la tabella dei comportamenti è quella attesa', () => {
    const casi: [WallSegment['kind'], WallSegment['doorState'], boolean, boolean][] = [
      ['opaque', 'closed', true, true],
      ['door', 'closed', true, true],
      ['door', 'locked', true, true],
      ['door', 'open', false, false],
      ['window', 'closed', false, true],
      ['sight_blocker', 'closed', true, false],
      ['movement_blocker', 'closed', false, true],
    ];
    for (const [kind, doorState, sight, movement] of casi) {
      expect(blocksSight({ kind, doorState })).toBe(sight);
      expect(blocksMovement({ kind, doorState })).toBe(movement);
    }
  });
});

describe('collisione nel movimento', () => {
  it('riporta il primo ostacolo incontrato, non uno qualsiasi', () => {
    const muri = [wall('lontano', 90, -50, 90, 50), wall('vicino', 30, -50, 30, 50)];
    const hit = firstMovementObstacle({ x: 0, y: 0 }, { x: 200, y: 0 }, muri);
    expect(hit?.wall.id).toBe('vicino');
    expect(hit?.point.x).toBeCloseTo(30, 6);
  });

  it('una porta aperta si attraversa', () => {
    const muri = [wall('d', 30, -50, 30, 50, 'door', 'open')];
    expect(firstMovementObstacle({ x: 0, y: 0 }, { x: 200, y: 0 }, muri)).toBeNull();
  });
});

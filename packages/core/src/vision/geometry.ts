import type { ImagePoint } from '../coordinates/types.js';
import { blocksMovement, blocksSight, type WallSegment } from './types.js';

/**
 * Primitive geometriche per la visione e le collisioni.
 *
 * Tutto lavora su segmenti: un muro è un segmento, e la domanda "si vede?" è
 * sempre "questo raggio incrocia un segmento che ferma lo sguardo?".
 */

/** Prodotto vettoriale in due dimensioni: dice da che parte gira un angolo. */
function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

const EPSILON = 1e-9;

export interface RayHit {
  /** Distanza lungo il raggio, in unità della direzione fornita. */
  distance: number;
  point: ImagePoint;
}

/**
 * Incrocio fra un raggio e un segmento.
 *
 * Restituisce null quando il raggio non lo tocca, quando lo tocca alle spalle
 * dell'origine, o quando sono paralleli: due rette parallele che si
 * sovrappongono non danno un punto di incrocio utile a nessuno.
 */
export function raySegmentHit(
  origin: ImagePoint,
  direction: ImagePoint,
  a: ImagePoint,
  b: ImagePoint,
): RayHit | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denominator = cross(direction.x, direction.y, sx, sy);
  if (Math.abs(denominator) < EPSILON) return null;

  const qpx = a.x - origin.x;
  const qpy = a.y - origin.y;
  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, direction.x, direction.y) / denominator;

  if (t < 0 || u < 0 || u > 1) return null;
  return { distance: t, point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t } };
}

/** Incrocio fra due segmenti, quando esiste. */
export function segmentIntersection(
  p1: ImagePoint,
  p2: ImagePoint,
  p3: ImagePoint,
  p4: ImagePoint,
): ImagePoint | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = p4.x - p3.x;
  const sy = p4.y - p3.y;
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) < EPSILON) return null;

  const qpx = p3.x - p1.x;
  const qpy = p3.y - p1.y;
  const t = cross(qpx, qpy, sx, sy) / denominator;
  const u = cross(qpx, qpy, rx, ry) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + rx * t, y: p1.y + ry * t };
}

/** Distanza minima fra un punto e un segmento. */
export function distanceToSegment(point: ImagePoint, a: ImagePoint, b: ImagePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Accorcia un segmento di un capello a entrambe le estremità.
 *
 * Serve quando la partenza o l'arrivo stanno esattamente su un muro — una
 * pedina appoggiata a una parete, una porta sull'angolo: senza questo, il
 * proprio muro di appoggio bloccherebbe ogni sguardo.
 */
function shrink(from: ImagePoint, to: ImagePoint, amount: number): [ImagePoint, ImagePoint] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= amount * 2) return [from, to];
  const ux = (dx / length) * amount;
  const uy = (dy / length) * amount;
  return [
    { x: from.x + ux, y: from.y + uy },
    { x: to.x - ux, y: to.y - uy },
  ];
}

/** Vero se fra i due punti non c'è nulla che fermi lo sguardo. */
export function hasLineOfSight(
  from: ImagePoint,
  to: ImagePoint,
  walls: readonly WallSegment[],
  tolerance = 0.01,
): boolean {
  const [start, end] = shrink(from, to, tolerance);
  for (const wall of walls) {
    if (!blocksSight(wall)) continue;
    const hit = segmentIntersection(
      start,
      end,
      { x: wall.ax, y: wall.ay },
      { x: wall.bx, y: wall.by },
    );
    if (hit) return false;
  }
  return true;
}

/** Il primo ostacolo al movimento incontrato lungo il percorso, se c'è. */
export function firstMovementObstacle(
  from: ImagePoint,
  to: ImagePoint,
  walls: readonly WallSegment[],
  tolerance = 0.01,
): { wall: WallSegment; point: ImagePoint } | null {
  const [start, end] = shrink(from, to, tolerance);
  let best: { wall: WallSegment; point: ImagePoint; distance: number } | null = null;
  for (const wall of walls) {
    if (!blocksMovement(wall)) continue;
    const hit = segmentIntersection(
      start,
      end,
      { x: wall.ax, y: wall.ay },
      { x: wall.bx, y: wall.by },
    );
    if (!hit) continue;
    const distance = Math.hypot(hit.x - from.x, hit.y - from.y);
    if (!best || distance < best.distance) best = { wall, point: hit, distance };
  }
  return best ? { wall: best.wall, point: best.point } : null;
}

/** Vero se il percorso non incontra ostacoli al movimento. */
export function canTraverse(
  from: ImagePoint,
  to: ImagePoint,
  walls: readonly WallSegment[],
): boolean {
  return firstMovementObstacle(from, to, walls) === null;
}

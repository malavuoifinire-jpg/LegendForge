import type { ImagePoint } from '../coordinates/types.js';
import { distanceToSegment, raySegmentHit } from './geometry.js';
import { blocksSight, type WallSegment } from './types.js';

/**
 * Poligono di visione.
 *
 * Si lanciano raggi verso ogni estremità di muro — e appena a lato di ciascuna,
 * perché è lì che lo sguardo scivola oltre lo spigolo — più una corona di raggi
 * regolari che disegna il bordo circolare della portata. Il punto più vicino
 * colpito da ogni raggio è un vertice del poligono.
 *
 * Il costo è proporzionale al numero di muri per il numero di raggi. Per
 * tenerlo basso si scartano prima i muri fuori portata: su una mappa grande la
 * gran parte non è mai in gioco.
 */

export interface VisibilityOptions {
  /** Portata massima dello sguardo, in pixel immagine. */
  radiusPx: number;
  /** Raggi regolari lungo il cerchio: più sono, più il bordo è liscio. */
  circleSegments?: number;
  /** Scostamento angolare dei raggi che sfiorano gli spigoli. */
  cornerOffset?: number;
}

const DEFAULTS = { circleSegments: 48, cornerOffset: 0.00015 };
const TWO_PI = Math.PI * 2;

export function computeVisibilityPolygon(
  origin: ImagePoint,
  walls: readonly WallSegment[],
  options: VisibilityOptions,
): ImagePoint[] {
  const radius = Math.max(1, options.radiusPx);
  const circleSegments = Math.max(12, options.circleSegments ?? DEFAULTS.circleSegments);
  const cornerOffset = options.cornerOffset ?? DEFAULTS.cornerOffset;

  // Solo i muri che fermano lo sguardo e che la portata può raggiungere.
  const relevant = walls.filter(
    (wall) =>
      blocksSight(wall) &&
      distanceToSegment(origin, { x: wall.ax, y: wall.ay }, { x: wall.bx, y: wall.by }) <= radius,
  );

  // Tutti gli angoli vivono in [0, 2π): `atan2` restituisce (-π, π] e mescolare
  // le due convenzioni scombinerebbe l'ordine dei vertici, e con esso il
  // poligono.
  const angles: number[] = [];
  const pushAngle = (angle: number) => {
    const normalized = angle % TWO_PI;
    angles.push(normalized < 0 ? normalized + TWO_PI : normalized);
  };

  for (let i = 0; i < circleSegments; i += 1) {
    pushAngle((i / circleSegments) * TWO_PI);
  }
  for (const wall of relevant) {
    for (const end of [
      { x: wall.ax, y: wall.ay },
      { x: wall.bx, y: wall.by },
    ]) {
      const angle = Math.atan2(end.y - origin.y, end.x - origin.x);
      pushAngle(angle - cornerOffset);
      pushAngle(angle);
      pushAngle(angle + cornerOffset);
    }
  }
  angles.sort((a, b) => a - b);

  const points: ImagePoint[] = [];
  let previousAngle = Number.NaN;
  for (const angle of angles) {
    // Angoli praticamente uguali darebbero vertici sovrapposti.
    if (Number.isFinite(previousAngle) && Math.abs(angle - previousAngle) < 1e-9) continue;
    previousAngle = angle;

    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    let nearest = radius;
    for (const wall of relevant) {
      const hit = raySegmentHit(
        origin,
        direction,
        { x: wall.ax, y: wall.ay },
        { x: wall.bx, y: wall.by },
      );
      if (hit && hit.distance < nearest) nearest = hit.distance;
    }
    points.push({
      x: origin.x + direction.x * nearest,
      y: origin.y + direction.y * nearest,
    });
  }

  return points;
}

/** Vero se il punto cade dentro il poligono (regola pari-dispari). */
export function polygonContains(polygon: readonly ImagePoint[], point: ImagePoint): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const straddles = a.y > point.y !== b.y > point.y;
    if (!straddles) continue;
    const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (point.x < crossingX) inside = !inside;
  }
  return inside;
}

/** Area del poligono, utile per verificarne la sensatezza nei test. */
export function polygonArea(polygon: readonly ImagePoint[]): number {
  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    total += (b.x + a.x) * (b.y - a.y);
  }
  return Math.abs(total / 2);
}

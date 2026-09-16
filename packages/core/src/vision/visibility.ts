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

  // Gli estremi condivisi si contano una volta sola. In una pianta fatta di
  // stanze quasi ogni spigolo appartiene a due muri, e lanciare due volte gli
  // stessi tre raggi raddoppierebbe il lavoro per niente.
  const seen = new Set<string>();
  for (const wall of relevant) {
    for (const end of [
      { x: wall.ax, y: wall.ay },
      { x: wall.bx, y: wall.by },
    ]) {
      const key = `${Math.round(end.x * 16)},${Math.round(end.y * 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
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

  return simplify(points);
}

/** Sotto questo scostamento in pixel un vertice non cambia quello che si vede. */
const SIMPLIFY_TOLERANCE_PX = 0.5;

/**
 * Toglie i vertici che non dicono niente.
 *
 * Il lancio dei raggi ne produce a migliaia, e tre su quattro cadono in fila
 * sullo stesso muro. Il poligono attraversa la rete fino a ogni giocatore a
 * ogni passo: mezzo pixel di scostamento non si vede, qualche decina di
 * kilobyte per movimento sì.
 */
function simplify(points: readonly ImagePoint[]): ImagePoint[] {
  if (points.length < 3) return points.map(round);
  const kept: ImagePoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = kept[kept.length - 1] ?? points[points.length - 1];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (!previous || !current || !next) continue;
    if (distanceToSegment(current, previous, next) > SIMPLIFY_TOLERANCE_PX) kept.push(round(current));
  }
  // Un poligono ridotto a meno di tre vertici non è più una superficie.
  return kept.length >= 3 ? kept : points.map(round);
}

/** Un decimo di pixel basta: il resto è peso sulla rete. */
function round(point: ImagePoint): ImagePoint {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
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

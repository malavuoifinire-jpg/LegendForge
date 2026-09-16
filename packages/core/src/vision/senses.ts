/**
 * Sensi di un attore e portata dello sguardo.
 *
 * La portata è in metri, come tutte le distanze del dominio: le caselle sono
 * una lettura, non l'unità di misura.
 */

export interface SpecialSense {
  name: string;
  rangeMeters: number;
}

export interface VisionProfile {
  /**
   * Quanto lontano si vede dove c'è luce. `null` significa "fin dove arriva la
   * scena": una stanza illuminata si vede tutta.
   */
  normalRangeMeters: number | null;
  /** Scurovisione: si vede al buio, entro questo raggio. */
  darkvisionMeters: number;
  /** Percezioni che non dipendono dalla luce ma restano fermate dai muri. */
  specialSenses: SpecialSense[];
  /** Altezza o livello della pedina: previsto, non ancora usato. */
  elevationMeters: number;
}

export const DEFAULT_VISION_PROFILE: VisionProfile = {
  normalRangeMeters: null,
  darkvisionMeters: 0,
  specialSenses: [],
  elevationMeters: 0,
};

/** Quanta luce c'è nella scena, da 0 (pieno giorno) a 1 (buio pesto). */
export type AmbientDarkness = number;

export type LightBand = 'bright' | 'dim' | 'dark';

/**
 * In che banda di luce si trova la scena.
 *
 * Tre bande invece di una scala continua: sono quelle che le regole
 * distinguono, e una soglia dichiarata è più onesta di un'interpolazione
 * inventata.
 */
export function lightBand(darkness: AmbientDarkness): LightBand {
  if (darkness < 0.34) return 'bright';
  if (darkness < 0.67) return 'dim';
  return 'dark';
}

export interface SightRadiusOptions {
  darkness: AmbientDarkness;
  /** Portata da usare quando la vista normale è illimitata. */
  sceneReachMeters: number;
}

export interface SightRadius {
  meters: number;
  /** Da dove viene la portata: utile da mostrare al Game Master. */
  source: 'normale' | 'scurovisione' | 'senso speciale' | 'luce' | 'nessuna';
}

/**
 * Portata dello sguardo di un attore.
 *
 * Al buio la vista normale non serve: restano scurovisione e sensi speciali.
 * Con luce piena vale la portata maggiore fra tutte.
 */
export function sightRadius(profile: VisionProfile, options: SightRadiusOptions): SightRadius {
  const special = profile.specialSenses.reduce(
    (max, sense) => Math.max(max, sense.rangeMeters),
    0,
  );
  const band = lightBand(options.darkness);

  const candidates: { meters: number; source: SightRadius['source'] }[] = [
    { meters: profile.darkvisionMeters, source: 'scurovisione' },
    { meters: special, source: 'senso speciale' },
  ];
  if (band !== 'dark') {
    candidates.push({
      meters: profile.normalRangeMeters ?? options.sceneReachMeters,
      source: 'normale',
    });
  }

  let best: SightRadius = { meters: 0, source: 'nessuna' };
  for (const candidate of candidates) {
    if (candidate.meters > best.meters) {
      best = { meters: candidate.meters, source: candidate.source };
    }
  }
  return best;
}

export interface LightSourceShape {
  x: number;
  y: number;
  brightRadiusMeters: number;
  dimRadiusMeters: number;
}

/**
 * Portata dello sguardo tenendo conto delle sorgenti di luce vicine.
 *
 * Una torcia illumina l'area attorno a sé: chi le sta dentro vede tutto quello
 * che la torcia illumina, anche senza scurovisione. Il numero restituito è il
 * raggio che contiene di sicuro tutta l'area illuminata — il punto illuminato
 * più lontano sta a distanza (distanza dalla sorgente + raggio della luce).
 *
 * È un limite superiore, non la forma esatta: serve a dimensionare il lancio
 * dei raggi. L'area davvero vista la compone il renderer intersecando il
 * poligono di visione con il disco di ciascuna luce.
 */
export function sightRadiusWithLights(
  profile: VisionProfile,
  position: { x: number; y: number },
  lights: readonly LightSourceShape[],
  options: SightRadiusOptions & { pixelsPerMeter: number },
): SightRadius {
  let best = sightRadius(profile, options);
  for (const light of lights) {
    const distanceMeters =
      Math.hypot(light.x - position.x, light.y - position.y) / Math.max(options.pixelsPerMeter, 1e-6);
    const reach = Math.max(light.brightRadiusMeters, light.dimRadiusMeters);
    // Fuori dal disco illuminato la luce non aggiunge nulla a quello che si vede.
    if (distanceMeters > reach) continue;
    const meters = distanceMeters + reach;
    if (meters > best.meters) best = { meters, source: 'luce' };
  }
  return best;
}

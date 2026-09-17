/**
 * Modi di movimento.
 *
 * Un modo è un nome e un comportamento: che cosa ignora e che cosa no. Le
 * velocità non stanno qui — quelle sono di chi si muove, e arrivano dal suo
 * profilo. Qui c'è solo la differenza fra camminare e volare.
 *
 * I nomi non sono un elenco chiuso: un modo inventato per una campagna si
 * comporta come il camminare finché qualcuno non dice altro. È il principio
 * di sempre — i contenuti sono dati, non codice.
 */

export interface MovementModeBehaviour {
  /** Il terreno difficile non rallenta: si passa sopra. */
  ignoresDifficultTerrain: boolean;
  /**
   * I muri non fermano. Quasi mai vero: si vola sopra un rovo, non attraverso
   * una parete. Lo scavare è l'eccezione per cui esiste.
   */
  ignoresWalls: boolean;
}

export const WALKING: MovementModeBehaviour = {
  ignoresDifficultTerrain: false,
  ignoresWalls: false,
};

/** Comportamento dei modi che il prodotto conosce di suo. */
export const MOVEMENT_MODES: Record<string, MovementModeBehaviour> = {
  camminare: WALKING,
  volare: { ignoresDifficultTerrain: true, ignoresWalls: false },
  nuotare: WALKING,
  scalare: WALKING,
  scavare: { ignoresDifficultTerrain: true, ignoresWalls: true },
  saltare: { ignoresDifficultTerrain: true, ignoresWalls: false },
};

export function behaviourOf(mode: string | undefined): MovementModeBehaviour {
  if (!mode) return WALKING;
  return MOVEMENT_MODES[mode.toLowerCase()] ?? WALKING;
}

/**
 * Velocità di chi si muove, in metri, per modo.
 *
 * Un modo assente significa che quella creatura non si muove così: un umano
 * non ha `volare`, e non è la stessa cosa che averlo a zero.
 */
export type MovementProfile = Record<string, number>;

/** Velocità base, quando nessuno ha detto altro: 9 metri, cioè 6 caselle. */
export const DEFAULT_WALK_METERS = 9;

export const DEFAULT_MOVEMENT_PROFILE: MovementProfile = { camminare: DEFAULT_WALK_METERS };

/** I modi che questa creatura ha davvero, in ordine, il più veloce per primo. */
export function availableModes(profile: MovementProfile): string[] {
  return Object.entries(profile)
    .filter(([, meters]) => Number.isFinite(meters) && meters > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([mode]) => mode);
}

export function speedFor(profile: MovementProfile, mode: string): number {
  const value = profile[mode.toLowerCase()] ?? profile[mode];
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}

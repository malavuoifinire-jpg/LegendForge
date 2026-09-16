import type { ImagePoint } from '../coordinates/types.js';

/**
 * Tipi di ostacolo.
 *
 * Vista e movimento sono due proprietà indipendenti: tenerle separate evita di
 * dover inventare un tipo nuovo ogni volta che serve una combinazione.
 */
export type WallKind =
  /** Muro pieno: ferma lo sguardo e il passo. */
  | 'opaque'
  /** Porta: dipende dal suo stato. */
  | 'door'
  /** Finestra: si vede attraverso, non ci si passa. */
  | 'window'
  /** Si attraversa ma non si vede attraverso: tenda, fogliame fitto, nebbia. */
  | 'sight_blocker'
  /** Si vede attraverso ma non si attraversa: ringhiera, dislivello, barriera. */
  | 'movement_blocker';

export type DoorState = 'closed' | 'open' | 'locked';

/** Segmento di ostacolo, in pixel dell'immagine della mappa. */
export interface WallSegment {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: WallKind;
  /** Significativo solo per le porte. */
  doorState: DoorState;
}

export function blocksSight(wall: Pick<WallSegment, 'kind' | 'doorState'>): boolean {
  switch (wall.kind) {
    case 'opaque':
    case 'sight_blocker':
      return true;
    case 'door':
      return wall.doorState !== 'open';
    case 'window':
    case 'movement_blocker':
      return false;
  }
}

export function blocksMovement(wall: Pick<WallSegment, 'kind' | 'doorState'>): boolean {
  switch (wall.kind) {
    case 'opaque':
    case 'window':
    case 'movement_blocker':
      return true;
    case 'door':
      return wall.doorState !== 'open';
    case 'sight_blocker':
      return false;
  }
}

export function segmentEnds(wall: WallSegment): [ImagePoint, ImagePoint] {
  return [
    { x: wall.ax, y: wall.ay },
    { x: wall.bx, y: wall.by },
  ];
}

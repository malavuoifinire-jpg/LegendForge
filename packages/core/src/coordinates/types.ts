/**
 * Sistemi di coordinate del tavolo virtuale.
 *
 *  1. `ImagePoint`  — pixel dell'immagine originale della mappa, origine in alto
 *                     a sinistra. È l'unico spazio che viene salvato.
 *  2. `CellCoord`   — indici interi di casella, derivati dalla griglia.
 *  3. metri         — derivati dalle caselle tramite `metersPerCell`.
 *  4. `ScreenPoint` — pixel del canvas; dipende da zoom e pan e non è mai salvato.
 */

/** Punto nello spazio immagine della mappa (pixel sorgente). */
export interface ImagePoint {
  x: number;
  y: number;
}

/** Punto nello spazio schermo del canvas (pixel CSS). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Coordinate intere di casella. */
export interface CellCoord {
  col: number;
  row: number;
}

/** Coordinate frazionarie di casella, utili per snap e anteprime. */
export interface CellVector {
  col: number;
  row: number;
}
